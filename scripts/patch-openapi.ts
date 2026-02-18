/**
 * Flattens discriminated unions (oneOf) in the OpenAPI spec into flat objects.
 *
 * specli generates CLI flags from request body schemas but can't handle oneOf/allOf yet.
 * This script detects discriminated unions in components.schemas and merges their
 * branches into a single flat object with unioned properties and intersected required.
 *
 * Uses parseDocument to preserve original YAML formatting of untouched nodes.
 */

import { readFileSync, writeFileSync } from "fs";
import { parseDocument, type Document } from "yaml";
import { resolve } from "path";
import { parseArgs } from "util";

const DEFAULT_OPENAPI_URL = "https://cloud.langfuse.com/generated/api/openapi.yml";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    refetch: { type: "boolean", default: false },
    openapi_url: { type: "string", default: DEFAULT_OPENAPI_URL },
  },
});

const specPath = resolve(import.meta.dirname!, "../openapi.yml");

if (args.refetch) {
  const url = args.openapi_url!;
  console.log(`Fetching spec from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  writeFileSync(specPath, await res.text());
  console.log(`Wrote fresh spec to ${specPath}`);
}

const raw = readFileSync(specPath, "utf-8");
const doc: Document = parseDocument(raw);

const schemas = doc.getIn(["components", "schemas"], true) as any;
if (!schemas || !schemas.items) {
  console.log("No components.schemas found, nothing to patch.");
  process.exit(0);
}

// Convert to JS for analysis (easier to work with)
const schemasJS = schemas.toJSON() as Record<string, any>;
let patchCount = 0;

for (const [name, schema] of Object.entries<any>(schemasJS)) {
  if (!schema.oneOf || !Array.isArray(schema.oneOf)) continue;

  // Check if every branch matches the discriminated union pattern:
  //   { allOf: [{ properties: { <disc>: { enum: [val] } } }, { $ref }], required: [<disc>] }
  const branches: Array<{
    discriminatorKey: string;
    discriminatorValue: string;
    refSchemaName: string;
  }> = [];

  let isDiscriminatedUnion = true;
  for (const branch of schema.oneOf) {
    if (!branch.allOf || branch.allOf.length !== 2) {
      isDiscriminatedUnion = false;
      break;
    }

    const [inline, ref] = branch.allOf;
    const props = inline?.properties;
    if (!props || !ref?.$ref) {
      isDiscriminatedUnion = false;
      break;
    }

    // Find the discriminator: a property with a single-value enum
    const discEntries = Object.entries<any>(props).filter(
      ([, v]) => v.type === "string" && Array.isArray(v.enum) && v.enum.length === 1,
    );
    if (discEntries.length !== 1) {
      isDiscriminatedUnion = false;
      break;
    }

    const [discKey, discSchema] = discEntries[0];
    const refName = ref.$ref.replace("#/components/schemas/", "");

    branches.push({
      discriminatorKey: discKey,
      discriminatorValue: discSchema.enum[0],
      refSchemaName: refName,
    });
  }

  if (!isDiscriminatedUnion || branches.length === 0) continue;

  // all branches should use the same discriminator key
  const discKey = branches[0].discriminatorKey;
  if (!branches.every((b) => b.discriminatorKey === discKey)) continue;

  const mergedProperties: Record<string, any> = {};
  const requiredSets: Set<string>[] = [];

  // property to discriminate
  mergedProperties[discKey] = {
    type: "string",
    enum: branches.map((b) => b.discriminatorValue),
  };

  for (const branch of branches) {
    const branchSchema = schemasJS[branch.refSchemaName];
    if (!branchSchema?.properties) continue;

    const branchRequired = new Set<string>(branchSchema.required ?? []);
    requiredSets.push(branchRequired);

    for (const [propName, propSchema] of Object.entries<any>(branchSchema.properties)) {
      if (propName === discKey) continue; // already handled

      if (!(propName in mergedProperties)) {
        mergedProperties[propName] = structuredClone(propSchema);
      } else {
        // property exists in multiple branches — check for type conflict
        const existing = mergedProperties[propName];
        if (JSON.stringify(existing) !== JSON.stringify(propSchema)) {
          // conflict: fall back to string so specli still exposes the flag
          mergedProperties[propName] = {
            type: "string",
            ...(existing.description ? { description: existing.description } : {}),
            ...(existing.nullable ? { nullable: true } : {}),
          };
        }
      }
    }
  }

  // Required = intersection of all branches' required fields + discriminator
  const intersectedRequired =
    requiredSets.length > 0
      ? [...requiredSets[0]].filter((r) => requiredSets.every((s) => s.has(r)))
      : [];
  const required = [discKey, ...intersectedRequired.filter((r) => r !== discKey)];

  // Strip nullable from properties that have no type (specli errors on these)
  for (const [propName, propSchema] of Object.entries<any>(mergedProperties)) {
    if (propSchema.nullable && !propSchema.type) {
      delete propSchema.nullable;
    }
  }

  const patched: any = {
    title: schema.title ?? name,
    type: "object",
    properties: mergedProperties,
  };
  if (required.length > 0) {
    patched.required = required;
  }

  // Replace the schema node in the document (preserves rest of doc formatting)
  doc.setIn(["components", "schemas", name], doc.createNode(patched));
  patchCount++;
  console.log(
    `Patched ${name}: merged ${branches.length} branches, ${required.length} required fields`,
  );
}

// Remove paths that shouldn't be exposed to CLI users
// const hiddenPaths = ["/api/public/traces", "/api/public/traces/{traceId}"];
const hiddenPaths: string[] = [];

const paths = doc.getIn(["paths"], true) as any;
if (paths?.items) {
  paths.items = paths.items.filter((pair: any) => {
    const pathStr = pair.key?.value;
    if (hiddenPaths.includes(pathStr)) {
      console.log(`Removed path: ${pathStr}`);
      return false;
    }
    return true;
  });
}

// Patch operation descriptions with examples
const examples: Record<string, string> = {
  prompts_create: [
    "Create a new version for the prompt with the given `name`",
    "",
    "Example:",
    "  langfuse api prompts create --type text --name my-prompt --prompt 'Hello {{name}}'",
  ].join("\n"),
};

if (paths?.items) {
  for (const pathPair of paths.items) {
    const methods = pathPair.value;
    if (!methods?.items) continue;
    for (const methodPair of methods.items) {
      const op = methodPair.value;
      if (!op?.items) continue;
      for (const field of op.items) {
        if (field.key?.value === "operationId" && examples[field.value?.value]) {
          for (const descField of op.items) {
            if (descField.key?.value === "description") {
              descField.value = doc.createNode(examples[field.value.value]);
              break;
            }
          }
        }
      }
    }
  }
}

// Rename query parameters that collide with specli's global flags.
// specli (via commander.js) reserves "--version" for CLI version display,
// so any OpenAPI query parameter named "version" becomes unusable.
const paramRenames: Record<string, Record<string, string>> = {
  prompts_get: { version: "prompt-version" },
};

let renameCount = 0;
if (paths?.items) {
  for (const pathPair of paths.items) {
    const methods = pathPair.value;
    if (!methods?.items) continue;
    for (const methodPair of methods.items) {
      const op = methodPair.value;
      if (!op?.items) continue;

      let operationId = "";
      for (const field of op.items) {
        if (field.key?.value === "operationId") {
          operationId = field.value?.value ?? "";
          break;
        }
      }

      const renames = paramRenames[operationId];
      if (!renames) continue;

      for (const field of op.items) {
        if (field.key?.value !== "parameters") continue;
        const params = field.value;
        if (!params?.items) continue;

        for (const param of params.items) {
          if (!param?.items) continue;
          let nameField: any = null;
          let inValue = "";
          for (const pf of param.items) {
            if (pf.key?.value === "name") nameField = pf;
            if (pf.key?.value === "in") inValue = pf.value?.value ?? "";
          }
          const oldName = nameField?.value?.value;
          if (oldName && inValue === "query" && renames[oldName]) {
            nameField.value = doc.createNode(renames[oldName]);
            renameCount++;
            console.log(
              `Renamed ${operationId} query param '${oldName}' → '${renames[oldName]}'`,
            );
          }
        }
      }
    }
  }
}

const dirty = patchCount > 0 || renameCount > 0;
if (dirty) {
  writeFileSync(specPath, doc.toString({ singleQuote: true }));
  console.log(`\nWrote patched spec to ${specPath} (${patchCount} schema(s), ${renameCount} param rename(s))`);
} else {
  console.log("No patches needed.");
}

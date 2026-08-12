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

import { flattenDiscriminatedUnion } from "./patch-openapi-logic";

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
  const result = flattenDiscriminatedUnion(name, schema, schemasJS);
  if (!result) continue;

  // Replace the schema node in the document (preserves rest of doc formatting)
  doc.setIn(["components", "schemas", name], doc.createNode(result.schema));
  patchCount++;
  console.log(
    `Patched ${name}: merged ${result.branchCount} branches, ${result.schema.required?.length ?? 0} required fields`,
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

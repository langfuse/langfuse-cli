import type { JsonSchema, JsonValue } from "./types";

const MAX_BRANCHES = 64;

export function resolveLocalRef(
  document: Record<string, any>,
  value: any,
  trail: string[] = [],
): any {
  if (!value?.$ref) return value;
  const ref = String(value.$ref);
  if (!ref.startsWith("#/")) {
    throw new Error(`External refs are not supported by the conformance compiler: ${ref}`);
  }
  if (trail.includes(ref)) return value;
  const target = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current: any, part) => current?.[part], document);
  if (!target) throw new Error(`Unresolved ref: ${ref}`);
  const siblings = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "$ref"),
  );
  return {
    ...resolveLocalRef(document, target, [...trail, ref]),
    ...siblings,
  };
}

function mergeSchemas(left: JsonSchema, right: JsonSchema): JsonSchema {
  const required = [...new Set([...(left.required ?? []), ...(right.required ?? [])])];
  const properties = { ...(left.properties ?? {}), ...(right.properties ?? {}) };
  return {
    ...left,
    ...right,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required } : {}),
  };
}

export function expandSchemaBranches(
  document: Record<string, any>,
  input: JsonSchema,
  trail: string[] = [],
): JsonSchema[] {
  const schema = resolveLocalRef(document, input, trail) as JsonSchema;
  if (schema.$ref) return [schema];
  if (Array.isArray(schema.oneOf)) {
    const base = { ...schema };
    delete base.oneOf;
    return schema.oneOf.flatMap((branch: JsonSchema) =>
      expandSchemaBranches(document, branch, trail).map((expanded) =>
        mergeSchemas(base, expanded),
      ),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    const base = { ...schema };
    delete base.anyOf;
    return schema.anyOf.flatMap((branch: JsonSchema) =>
      expandSchemaBranches(document, branch, trail).map((expanded) =>
        mergeSchemas(base, expanded),
      ),
    );
  }
  if (Array.isArray(schema.allOf)) {
    const base = { ...schema };
    delete base.allOf;
    let branches: JsonSchema[] = [base];
    for (const part of schema.allOf) {
      const expanded = expandSchemaBranches(document, part, trail);
      branches = branches.flatMap((left) =>
        expanded.map((right) => mergeSchemas(left, right)),
      );
      if (branches.length > MAX_BRANCHES) {
        throw new Error(`Schema expands beyond ${MAX_BRANCHES} branches`);
      }
    }
    return branches;
  }
  return [schema];
}

function sampleString(schema: JsonSchema, seed: string): string {
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (schema.format === "date-time") return "2024-01-02T03:04:05.000Z";
  if (schema.format === "date") return "2024-01-02";
  if (schema.format === "email") return "cli-conformance@example.com";
  if (schema.format === "uri" || schema.format === "url") {
    return "https://example.com/conformance";
  }
  const minLength = Math.max(Number(schema.minLength ?? 0), 1);
  const base = `test-${seed}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  return base.padEnd(minLength, "x").slice(0, schema.maxLength ?? undefined);
}

export function sampleFromSchema(
  document: Record<string, any>,
  input: JsonSchema | undefined,
  seed = "value",
  trail: string[] = [],
): JsonValue {
  if (!input) return null;
  const schema = resolveLocalRef(document, input, trail) as JsonSchema;
  if (schema.$ref) return null;
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0]);
  }
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const [branch] = expandSchemaBranches(document, schema, trail);
    return sampleFromSchema(document, branch, seed, trail);
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate: string) => candidate !== "null")
    : schema.type;
  if (type === "string" || (!type && schema.format)) return sampleString(schema, seed);
  if (type === "integer") {
    const minimum = Number(schema.minimum ?? 1);
    return Math.max(Math.ceil(minimum), 1);
  }
  if (type === "number") {
    const minimum = Number(schema.minimum ?? 1);
    return Math.max(minimum, 1);
  }
  if (type === "boolean") return true;
  if (type === "array") {
    const count = Math.max(Number(schema.minItems ?? 1), 1);
    return Array.from({ length: count }, (_, index) =>
      sampleFromSchema(document, schema.items, `${seed}-${index + 1}`, trail),
    );
  }
  if (type === "object" || schema.properties) {
    const result: Record<string, JsonValue> = {};
    const required = new Set<string>(schema.required ?? []);
    for (const [name, property] of Object.entries<JsonSchema>(
      schema.properties ?? {},
    )) {
      if (required.has(name)) {
        result[name] = sampleFromSchema(document, property, name, trail);
      }
    }
    if (Object.keys(result).length === 0 && schema.additionalProperties) {
      result.key = sampleFromSchema(
        document,
        schema.additionalProperties === true ? { type: "string" } : schema.additionalProperties,
        "value",
        trail,
      );
    }
    return result;
  }
  return sampleString(schema, seed);
}

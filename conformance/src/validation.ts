import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import type { JsonSchema, JsonValue } from "./types";

function normalizeNullable(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeNullable);
  if (!value || typeof value !== "object") return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeNullable(child)]),
  );
  if (!normalized.nullable) return normalized;
  delete normalized.nullable;
  if (typeof normalized.type === "string") {
    normalized.type = [normalized.type, "null"];
    return normalized;
  }
  if (Array.isArray(normalized.type) && !normalized.type.includes("null")) {
    normalized.type.push("null");
    return normalized;
  }
  return { anyOf: [normalized, { type: "null" }] };
}

export function validateSchemaValue(
  document: Record<string, any>,
  schema: JsonSchema,
  value: JsonValue,
): { valid: boolean; errors: ErrorObject[] } {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const root = {
    components: normalizeNullable(structuredClone(document.components ?? {})),
    definitions: {
      target: normalizeNullable(structuredClone(schema)),
    },
    $ref: "#/definitions/target",
  };
  const validate = ajv.compile(root);
  const valid = validate(value);
  return { valid: Boolean(valid), errors: validate.errors ?? [] };
}

export function validateSchemaCases(
  document: Record<string, any>,
  cases: Array<{ label: string; schema: JsonSchema; value: JsonValue }>,
): { valid: boolean; errors: Array<{ label: string; error: ErrorObject }> } {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const root = {
    components: normalizeNullable(structuredClone(document.components ?? {})),
    type: "array",
    items: cases.map(({ schema }) => normalizeNullable(structuredClone(schema))),
    additionalItems: false,
  };
  const validate = ajv.compile(root);
  const valid = validate(cases.map(({ value }) => value));
  return {
    valid: Boolean(valid),
    errors: (validate.errors ?? []).map((error) => {
      const match = error.instancePath.match(/^\/(\d+)/);
      const index = match ? Number(match[1]) : -1;
      return { label: cases[index]?.label ?? "unknown", error };
    }),
  };
}

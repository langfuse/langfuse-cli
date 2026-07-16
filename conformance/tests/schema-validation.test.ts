import { describe, expect, test } from "bun:test";

import { loadCatalog, readVerifiedSpec } from "../src/catalog";
import { compileOpenApi } from "../src/openapi";
import { resolveLocalRef } from "../src/schema";
import { validateSchemaCases } from "../src/validation";
import type { JsonSchema, JsonValue } from "../src/types";

const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

function originalOperation(document: Record<string, any>, key: string): any {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator).toLowerCase();
  const path = key.slice(separator + 1);
  if (!methods.has(method)) throw new Error(`Invalid operation key: ${key}`);
  return document.paths[path][method];
}

function originalParameters(
  document: Record<string, any>,
  key: string,
): any[] {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator).toLowerCase();
  const path = key.slice(separator + 1);
  const pathItem = document.paths[path];
  const operation = pathItem[method];
  const merged = new Map<string, any>();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = resolveLocalRef(document, raw);
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

describe("generated samples against original OpenAPI schemas", () => {
  test("every catalog sample is valid according to its untouched source schema", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const raw = await readVerifiedSpec(entry);
      const compiled = compileOpenApi(entry, raw, catalog.specPath);
      const cases: Array<{ label: string; schema: JsonSchema; value: JsonValue }> = [];
      for (const operation of compiled.manifest.operations) {
        const original = originalOperation(compiled.document, operation.key);
        const parameters = originalParameters(compiled.document, operation.key);
        for (const parameter of operation.parameters) {
          const source = parameters.find(
            (candidate) =>
              candidate.in === parameter.location && candidate.name === parameter.name,
          );
          cases.push({
            label: `${operation.operationId} parameter ${parameter.name}`,
            schema: source.schema,
            value: parameter.sample,
          });
        }
        if (operation.requestBody) {
          const requestBody = resolveLocalRef(compiled.document, original.requestBody);
          const schema = requestBody.content[operation.requestBody.contentType].schema;
          for (const branch of operation.requestBody.branches) {
            cases.push({
              label: `${operation.operationId} body ${branch.id}`,
              schema,
              value: branch.sample,
            });
          }
        }
        for (const response of operation.responses) {
          if (response.sample === undefined || !response.contentType) continue;
          const originalResponse = resolveLocalRef(
            compiled.document,
            original.responses[response.key],
          );
          const schema = originalResponse.content[response.contentType]?.schema;
          if (!schema) continue;
          cases.push({
            label: `${operation.operationId} response ${response.key}`,
            schema,
            value: response.sample,
          });
        }
      }
      const result = validateSchemaCases(compiled.document, cases);
      expect(
        result.valid,
        `${entry.ref}: ${JSON.stringify(result.errors.slice(0, 20))}`,
      ).toBe(true);
    }
  }, 30_000);
});

import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog";
import { generateCorpus } from "../src/generator";
import { resolveLocalRef } from "../src/schema";
import { validateSchemaCases } from "../src/validation";
import type {
  ConformanceVector,
  JsonSchema,
  JsonValue,
  ParameterContract,
} from "../src/types";

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

function parameterValue(
  vector: ConformanceVector,
  parameter: ParameterContract,
): JsonValue | undefined {
  if (parameter.location === "path") return vector.input.path[parameter.name];
  if (parameter.location === "query") return vector.input.query[parameter.name];
  if (parameter.location === "header") return vector.input.headers[parameter.name];
  return vector.input.cookies[parameter.name];
}

describe("generated samples against original OpenAPI schemas", () => {
  test("every generated endpoint call is valid against its untouched spec", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const { compiled, vectors } = await generateCorpus(entry);
      const cases: Array<{ label: string; schema: JsonSchema; value: JsonValue }> = [];
      for (const vector of vectors) {
        const operation = compiled.manifest.operations.find(
          (candidate) => candidate.key === vector.operationKey,
        );
        if (!operation) throw new Error(`${vector.id}: operation not found`);
        const original = originalOperation(compiled.document, operation.key);
        const parameters = originalParameters(compiled.document, operation.key);
        for (const parameter of operation.parameters) {
          const value = parameterValue(vector, parameter);
          if (value === undefined) continue;
          const source = parameters.find(
            (candidate) =>
              candidate.in === parameter.location && candidate.name === parameter.name,
          );
          cases.push({
            label: `${operation.operationId} parameter ${parameter.name}`,
            schema: source.schema,
            value,
          });
        }
        if (operation.requestBody && vector.input.body !== undefined) {
          const requestBody = resolveLocalRef(compiled.document, original.requestBody);
          const schema = requestBody.content[operation.requestBody.contentType].schema;
          cases.push({
            label: `${operation.operationId} body`,
            schema,
            value: vector.input.body,
          });
        }
        const response = vector.response;
        if (response.sample !== undefined && response.contentType) {
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

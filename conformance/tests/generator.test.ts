import { describe, expect, test } from "bun:test";

import { coverageReport, generateVectors } from "../src/generator";
import { compileOpenApi } from "../src/openapi";

const raw = `openapi: 3.0.1
info:
  title: fixture
  version: '1'
paths:
  /widgets/{id}:
    get:
      operationId: widgets_get
      tags: [Widgets]
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
        - in: query
          name: limit
          required: true
          schema: { type: integer, minimum: 1 }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: object, properties: { ok: { type: boolean } }, required: [ok] }
        '404': { description: missing }
  /widgets:
    post:
      operationId: widgets_create
      tags: [Widgets]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
              required: [name]
      responses:
        '201': { description: created }
`;

describe("language-neutral conformance generation", () => {
  test("covers every operation, parameter, required field, and response", () => {
    const compiled = compileOpenApi(
      {
        version: "fixture",
        ref: "fixture",
        commit: "0".repeat(40),
        sha256: "0".repeat(64),
      },
      raw,
      "fixture.yml",
    );
    const vectors = generateVectors(compiled);
    const coverage = coverageReport(compiled, vectors);
    expect(coverage.unsupported).toEqual([]);
    expect(coverage.sourceIssues).toEqual([]);
    expect(coverage.counts).toEqual({
      paths: 2,
      operations: 2,
      parameters: 2,
      requiredParameters: 2,
      requestBodies: 1,
      bodyBranches: 1,
      requiredBodyFields: 1,
      responses: 3,
      vectors: 15,
    });
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(vectors.length);
    expect(vectors.filter((vector) => vector.kind === "response")).toHaveLength(3);
    expect(
      vectors.filter((vector) => vector.kind === "missing-required-parameter"),
    ).toHaveLength(2);
    expect(
      vectors.filter((vector) => vector.kind === "missing-required-body-field"),
    ).toHaveLength(1);
  });
});

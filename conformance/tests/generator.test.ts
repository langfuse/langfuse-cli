import { describe, expect, test } from "bun:test";

import { generateVectors } from "../src/generator";
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

describe("endpoint call generation", () => {
  test("creates one minimally valid request per operation", () => {
    const compiled = compileOpenApi(
      {
        version: "fixture",
        ref: "fixture",
        commit: "0".repeat(40),
        sha256: "0".repeat(64),
      },
      raw,
    );
    const vectors = generateVectors(compiled);
    expect(compiled.unsupported).toEqual([]);
    expect(vectors).toHaveLength(2);
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(vectors.length);
    expect(vectors.map((vector) => vector.operationId)).toEqual([
      "widgets_create",
      "widgets_get",
    ]);
    expect(vectors[0].input.body).toEqual({ name: "test-name" });
    expect(vectors[0].response.status).toBe(201);
    expect(vectors[1].input.path).toEqual({ id: "test-id" });
    expect(vectors[1].input.query).toEqual({ limit: 1 });
  });
});

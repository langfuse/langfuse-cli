import { describe, expect, test } from "bun:test";

import { assertOverridesApplied, compileApiContract } from "./compiler";
import type { ContractOverrides } from "./types";

const SOURCE = { version: "test", ref: "test", sha256: "test" };

function overrides(partial: Partial<ContractOverrides>): ContractOverrides {
  return {
    schemaVersion: 1,
    parameterFlagAliases: {},
    bodyFieldFlags: {},
    commandOverrides: {},
    ...partial,
  };
}

const spec = `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /widgets:
    get:
      operationId: widgets_list
      tags: [Widget]
      parameters:
        - in: query
          name: q
          schema: { type: string }
      responses:
        '200': { description: ok }
  /gadgets:
    get:
      operationId: gadgets_list
      responses:
        '200': { description: ok }
  /things:
    post:
      operationId: things_create
      parameters:
        - in: query
          name: q
          schema: { type: string }
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

describe("pagination detection", () => {
  test("classifies page, cursor, and unpaginated operations", () => {
    const paged = `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /widgets:
    get:
      operationId: widgets_list
      parameters:
        - { in: query, name: page, schema: { type: integer } }
        - { in: query, name: limit, schema: { type: integer } }
      responses:
        '200': { description: ok }
  /events:
    get:
      operationId: events_list
      parameters:
        - { in: query, name: cursor, schema: { type: string } }
        - { in: query, name: page, schema: { type: integer } }
      responses:
        '200': { description: ok }
  /health:
    get:
      operationId: health_get
      responses:
        '200': { description: ok }
`;
    const contract = compileApiContract(SOURCE, paged);
    const byId = new Map(
      contract.operations.map((operation) => [operation.operationId, operation]),
    );
    expect(byId.get("widgets_list")?.pagination).toBe("page");
    // cursor wins when both parameters exist
    expect(byId.get("events_list")?.pagination).toBe("cursor");
    expect(byId.get("health_get")?.pagination).toBeUndefined();
  });
});

describe("help metadata extraction", () => {
  test("captures enums, descriptions, and union bodies", () => {
    const contract = compileApiContract(
      SOURCE,
      `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /prompts:
    post:
      operationId: prompts_create
      parameters:
        - in: query
          name: level
          description: |
            Filter by level.
            Long second line that should be collapsed into one.
          schema: { type: string, enum: [DEBUG, WARNING] }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  properties:
                    type: { type: string, enum: [chat] }
                    prompt: { type: array, items: { type: object } }
                  required: [type, prompt]
                - type: object
                  properties:
                    type: { type: string, enum: [text] }
                    prompt: { type: string, description: "The prompt text." }
                    config: { nullable: true }
                  required: [type, prompt]
      responses:
        '200': { description: ok }
`,
    );
    const operation = contract.operations[0];
    const level = operation.parameters.find((p) => p.name === "level")!;
    expect(level.enum).toEqual(["DEBUG", "WARNING"]);
    expect(level.description).toBe(
      "Filter by level. Long second line that should be collapsed into one.",
    );
    expect(operation.requestBody?.union).toBe(true);
    const type = operation.requestBody!.fields.find((f) => f.name === "type")!;
    expect(type.enum).toEqual(["chat", "text"]);
    const prompt = operation.requestBody!.fields.find((f) => f.name === "prompt")!;
    // one branch is not enum-constrained, so no enum is claimed
    expect(prompt.enum).toBeUndefined();
    expect(prompt.description).toBe("The prompt text.");

    // unconstrained schemas (e.g. `nullable: true` only) are "any", not
    // "string": structured values must not be stringified
    const config = operation.requestBody!.fields.find((f) => f.name === "config")!;
    expect(config.kind).toBe("any");

    // discriminated union: variants keyed by the inferred "type" property,
    // with branch-specific kinds preserved
    const discriminator = operation.requestBody!.discriminator!;
    expect(discriminator.field).toBe("type");
    expect(Object.keys(discriminator.variants).sort()).toEqual(["chat", "text"]);
    expect(
      discriminator.variants.text.find((f) => f.name === "prompt")?.kind,
    ).toBe("string");
    expect(
      discriminator.variants.chat.find((f) => f.name === "prompt")?.kind,
    ).toBe("array");
  });

  test("union bodies are json-only structurally, even for unlisted operations", () => {
    // operationId deliberately NOT in FIELD_FLAGS_UNSUPPORTED: a union
    // op added by a future spec must not silently get merged field flags,
    // and must gain variant flags when a discriminator is inferable.
    const contract = compileApiContract(
      SOURCE,
      `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /future:
    post:
      operationId: future_create
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  properties:
                    kind: { type: string, enum: [a] }
                    left: { type: string }
                  required: [kind, left]
                - type: object
                  properties:
                    kind: { type: string, enum: [b] }
                    right: { type: number }
                  required: [kind, right]
      responses:
        '200': { description: ok }
`,
    );
    const body = contract.operations[0].requestBody!;
    expect(body.fieldFlags).toBe(false);
    expect(body.discriminator?.field).toBe("kind");
    expect(Object.keys(body.discriminator!.variants).sort()).toEqual(["a", "b"]);
  });

  test("unions without a clean discriminator stay body-json-only", () => {
    const contract = compileApiContract(
      SOURCE,
      `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /rules:
    post:
      operationId: unstable_evaluationRules_create
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  properties:
                    name: { type: string }
                    evaluator: { type: object }
                  required: [name]
                - type: object
                  properties:
                    name: { type: string }
                    mapping: { type: array, items: { type: object } }
                  required: [name]
      responses:
        '200': { description: ok }
`,
    );
    expect(contract.operations[0].requestBody?.union).toBe(true);
    expect(contract.operations[0].requestBody?.discriminator).toBeUndefined();
  });
});

describe("contract overrides", () => {
  test("applies a parameter flag alias and verifies application", () => {
    const withAlias = overrides({
      parameterFlagAliases: {
        widgets_list: [{ location: "query", parameter: "q", flag: "query" }],
      },
    });
    const contract = compileApiContract(SOURCE, spec, withAlias);
    const parameter = contract.operations
      .find((operation) => operation.operationId === "widgets_list")!
      .parameters.find((candidate) => candidate.name === "q")!;
    expect(parameter.cliAliases).toEqual(["query"]);
    expect(() => assertOverridesApplied([contract], withAlias)).not.toThrow();
  });

  test("rejects an alias colliding with a legacy body-field flag", () => {
    expect(() =>
      compileApiContract(
        SOURCE,
        spec,
        overrides({
          parameterFlagAliases: {
            things_create: [{ location: "query", parameter: "q", flag: "name" }],
          },
        }),
      ),
    ).toThrow("collides with an existing option");
  });

  test("rejects an alias targeting a path parameter", () => {
    expect(() =>
      compileApiContract(
        SOURCE,
        `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /widgets/{id}:
    get:
      operationId: widgets_get
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        '200': { description: ok }
`,
        overrides({
          parameterFlagAliases: {
            widgets_get: [
              { location: "path", parameter: "id", flag: "widget-id" } as any,
            ],
          },
        }),
      ),
    ).toThrow("path parameters are positional");
  });

  test("rejects an alias colliding with a reserved or global flag", () => {
    for (const flag of ["json", "body-json", "output"]) {
      expect(() =>
        compileApiContract(
          SOURCE,
          spec,
          overrides({
            parameterFlagAliases: {
              widgets_list: [{ location: "query", parameter: "q", flag }],
            },
          }),
        ),
      ).toThrow("collides with a reserved or global flag");
    }
  });

  test("derives kebab-case body-field flags and fails closed on collisions", () => {
    const contract = compileApiContract(SOURCE, spec);
    const fields = contract.operations.find(
      (operation) => operation.operationId === "things_create",
    )!.requestBody!.fields;
    expect(fields[0].cliName).toBe("name");

    // body field kebab-casing onto a reserved/global flag
    const reservedSpec = spec
      .replace("name: { type: string }", "bodyJson: { type: string }")
      .replace("required: [name]", "required: [bodyJson]");
    expect(() => compileApiContract(SOURCE, reservedSpec)).toThrow(
      "collides with a reserved or global flag",
    );

    // two wire names kebab-casing onto the same flag
    const dupSpec = spec
      .replace(
        "name: { type: string }",
        "userId: { type: string }\n                user_id: { type: string }",
      )
      .replace("required: [name]", "required: [userId]");
    expect(() => compileApiContract(SOURCE, dupSpec)).toThrow(
      "collides with an existing option",
    );

    // body field colliding with a query parameter's flag
    const paramClash = spec
      .replace("name: { type: string }", "q: { type: string }")
      .replace("required: [name]", "required: [q]");
    expect(() => compileApiContract(SOURCE, paramClash)).toThrow(
      "collides with an existing option",
    );
  });

  test("renames colliding body-field flags via overrides and verifies application", () => {
    const reservedSpec = spec
      .replace("name: { type: string }", "secretKey: { type: string }")
      .replace("required: [name]", "required: [secretKey]");
    const withRename = overrides({
      bodyFieldFlags: { things_create: { secretKey: "provider-secret-key" } },
    });
    const contract = compileApiContract(SOURCE, reservedSpec, withRename);
    const field = contract.operations
      .find((operation) => operation.operationId === "things_create")!
      .requestBody!.fields.find((candidate) => candidate.name === "secretKey")!;
    expect(field.cliName).toBe("provider-secret-key");
    expect(() => assertOverridesApplied([contract], withRename)).not.toThrow();

    const stale = overrides({
      bodyFieldFlags: { things_create: { nonexistent: "x-flag" } },
    });
    expect(() =>
      assertOverridesApplied([compileApiContract(SOURCE, spec, stale)], stale),
    ).toThrow("applied in no compiled contract");
  });

  test("rejects a command override colliding with another operation's alias", () => {
    // widgets_list carries the tag alias "widget list"; renaming gadgets_list
    // onto that pair must fail instead of silently shadowing it at runtime.
    expect(() =>
      compileApiContract(
        SOURCE,
        spec,
        overrides({
          commandOverrides: {
            test: { gadgets_list: { resource: "widget", action: "list" } },
          },
        }),
      ),
    ).toThrow("duplicate command widget list");
  });

  test("tolerates a missing parameter per version but rejects entries applied nowhere", () => {
    const stale = overrides({
      parameterFlagAliases: {
        widgets_list: [
          { location: "query", parameter: "missing", flag: "query" },
        ],
      },
    });
    const contract = compileApiContract(SOURCE, spec, stale);
    expect(() => assertOverridesApplied([contract], stale)).toThrow(
      "applied in no compiled contract",
    );
    const unknownOperation = overrides({
      parameterFlagAliases: {
        nonexistent_op: [{ location: "query", parameter: "q", flag: "query" }],
      },
    });
    expect(() =>
      assertOverridesApplied(
        [compileApiContract(SOURCE, spec, unknownOperation)],
        unknownOperation,
      ),
    ).toThrow("applied in no compiled contract");
  });

  test("renaming the discriminator field moves the selection flag with it", () => {
    const unionSpec = `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /things:
    post:
      operationId: things_create
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  properties:
                    type: { type: string, enum: [a] }
                    left: { type: string }
                  required: [type]
                - type: object
                  properties:
                    type: { type: string, enum: [b] }
                    right: { type: string }
                  required: [type]
      responses:
        '200': { description: ok }
`;
    const contract = compileApiContract(
      SOURCE,
      unionSpec,
      overrides({ bodyFieldFlags: { things_create: { type: "thing-type" } } }),
    );
    const body = contract.operations[0].requestBody!;
    expect(body.discriminator?.cliName).toBe("thing-type");
    for (const fields of Object.values(body.discriminator!.variants)) {
      expect(fields.find((f) => f.name === "type")?.cliName).toBe("thing-type");
    }
  });

  test("rejects command overrides for unknown versions or operations", () => {
    const contract = compileApiContract(SOURCE, spec);
    expect(() =>
      assertOverridesApplied(
        [contract],
        overrides({ commandOverrides: { "9.9.9": {} } }),
      ),
    ).toThrow("unknown version");
    expect(() =>
      assertOverridesApplied(
        [contract],
        overrides({ commandOverrides: { test: { nope: { action: "list" } } } }),
      ),
    ).toThrow("matches no operation");
  });
});

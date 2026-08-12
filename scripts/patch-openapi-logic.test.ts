import { describe, expect, test } from "bun:test";

import { flattenDiscriminatedUnion } from "./patch-openapi-logic";

describe("flattenDiscriminatedUnion", () => {
  test("flattens oneOf branches that reference schemas with enum discriminators", () => {
    const schemas = {
      CreatePromptRequest: {
        title: "CreatePromptRequest",
        oneOf: [
          { $ref: "#/components/schemas/CreateChatPromptRequest" },
          { $ref: "#/components/schemas/CreateTextPromptRequest" },
        ],
      },
      CreateChatPromptRequest: {
        type: "object",
        properties: {
          name: { type: "string" },
          prompt: { type: "array" },
          type: { $ref: "#/components/schemas/CreateChatPromptType" },
        },
        required: ["name", "prompt", "type"],
      },
      CreateTextPromptRequest: {
        type: "object",
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
          type: { $ref: "#/components/schemas/CreateTextPromptType" },
        },
        required: ["name", "prompt"],
      },
      CreateChatPromptType: { type: "string", enum: ["chat"] },
      CreateTextPromptType: { type: "string", enum: ["text"] },
    };

    const result = flattenDiscriminatedUnion(
      "CreatePromptRequest",
      schemas.CreatePromptRequest,
      schemas,
    );

    expect(result?.branchCount).toBe(2);
    expect(result?.schema.properties.type).toEqual({
      type: "string",
      enum: ["chat", "text"],
    });
    expect(result?.schema.properties.prompt.type).toBe("string");
    expect(result?.schema.required).toEqual(["type", "name", "prompt"]);
  });

  test("keeps the existing allOf discriminator shape working", () => {
    const schemas = {
      Union: {
        oneOf: [
          {
            allOf: [
              { properties: { kind: { type: "string", enum: ["a"] } } },
              { $ref: "#/components/schemas/BranchA" },
            ],
          },
          {
            allOf: [
              { properties: { kind: { type: "string", enum: ["b"] } } },
              { $ref: "#/components/schemas/BranchB" },
            ],
          },
        ],
      },
      BranchA: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      BranchB: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    };

    const result = flattenDiscriminatedUnion("Union", schemas.Union, schemas);

    expect(result?.branchCount).toBe(2);
    expect(result?.schema.properties.kind.enum).toEqual(["a", "b"]);
    expect(result?.schema.required).toEqual(["kind", "value"]);
  });

  test("does not flatten an untagged oneOf", () => {
    const schemas = {
      Union: {
        oneOf: [
          { $ref: "#/components/schemas/First" },
          { $ref: "#/components/schemas/Second" },
        ],
      },
      First: { type: "object", properties: { value: { type: "string" } } },
      Second: { type: "object", properties: { count: { type: "integer" } } },
    };

    expect(flattenDiscriminatedUnion("Union", schemas.Union, schemas)).toBeUndefined();
  });
});

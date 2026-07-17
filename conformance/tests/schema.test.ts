import { describe, expect, test } from "bun:test";

import { expandSchemaBranches, sampleFromSchema } from "../src/schema";

const document = {
  components: {
    schemas: {
      Base: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      Text: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
      Chat: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["messages"],
      },
    },
  },
};

describe("OpenAPI schema expansion and sampling", () => {
  test("expands oneOf/allOf branches and preserves branch requirements", () => {
    const branches = expandSchemaBranches(document, {
      oneOf: [
        {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { $ref: "#/components/schemas/Text" },
          ],
        },
        {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { $ref: "#/components/schemas/Chat" },
          ],
        },
      ],
    });
    expect(branches).toHaveLength(2);
    expect(branches[0].required).toEqual(["name", "prompt"]);
    expect(branches[1].required).toEqual(["name", "messages"]);
  });

  test("creates deterministic, minimally valid branch samples", () => {
    const sample = sampleFromSchema(document, {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { $ref: "#/components/schemas/Chat" },
      ],
    });
    expect(sample).toEqual({ name: "test-name", messages: ["test-messages-1"] });
  });
});

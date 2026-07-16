import { describe, expect, test } from "bun:test";

import { expectedRequest } from "../src/serialize";
import type { OperationContract } from "../src/types";

const operation: OperationContract = {
  key: "GET /items/{itemId}",
  operationId: "items_get",
  method: "GET",
  path: "/items/{itemId}",
  tags: ["Items"],
  auth: { required: false, schemes: [] },
  command: { resource: "items", action: "get", canonicalAction: "get" },
  pathParameterOrder: ["itemId"],
  parameters: [
    {
      location: "path",
      name: "itemId",
      cliName: "item-id",
      required: true,
      style: "simple",
      explode: false,
      schema: { type: "string" },
      sample: "a/b",
    },
    {
      location: "query",
      name: "tag",
      cliName: "tag",
      required: false,
      style: "form",
      explode: true,
      schema: { type: "array", items: { type: "string" } },
      sample: ["one", "two"],
    },
  ],
  responses: [],
};

describe("OpenAPI request serialization", () => {
  test("encodes paths and form+explode arrays", () => {
    expect(
      expectedRequest(operation, {
        path: { itemId: "a/b" },
        query: { tag: ["one", "two"] },
        headers: {},
        cookies: {},
      }),
    ).toEqual({
      method: "GET",
      pathname: "/items/a%2Fb",
      query: [
        ["tag", "one"],
        ["tag", "two"],
      ],
      headers: {},
    });
  });
});

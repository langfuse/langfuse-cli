import { expect, test } from "bun:test";

import { invocationArgs } from "../src/invocation";
import type {
  ConformanceVector,
  Manifest,
  OperationContract,
} from "../src/types";

const operation: OperationContract = {
  key: "POST /widgets/{id}",
  operationId: "widgets_create",
  method: "POST",
  path: "/widgets/{id}",
  auth: { required: true, schemes: ["BasicAuth"] },
  command: { resource: "widgets", action: "create" },
  pathParameterOrder: ["id"],
  parameters: [
    {
      location: "path",
      name: "id",
      cliName: "id",
      required: true,
      style: "simple",
      explode: false,
      sample: "widget-1",
    },
    {
      location: "query",
      name: "dryRun",
      cliName: "dry-run",
      required: false,
      style: "form",
      explode: true,
      sample: true,
    },
  ],
  requestBody: {
    required: true,
    contentType: "application/json",
    sample: { name: "test", nested: { count: 1 } },
  },
  responses: [],
};

test("creates a lossless CLI invocation", async () => {
  const manifest: Manifest = { version: "fixture", operations: [operation] };
  const vector: ConformanceVector = {
    id: "fixture:widgets_create:minimal-request",
    version: "fixture",
    operationKey: operation.key,
    operationId: operation.operationId,
    command: operation.command,
    input: {
      path: { id: "widget-1" },
      query: { dryRun: true },
      headers: {},
      cookies: {},
      body: { name: "test", nested: { count: 1 } },
    },
    expectedRequest: {
      method: "POST",
      pathname: "/widgets/widget-1",
      query: [["dryRun", "true"]],
      headers: {},
      body: { name: "test", nested: { count: 1 } },
    },
    response: { key: "200", status: 200 },
  };
  const args = invocationArgs({
    vector,
    manifest,
    host: "http://127.0.0.1:3000",
  });
  expect(args).toContain("--body-json");
  expect(args).toContain('{"name":"test","nested":{"count":1}}');
});

import { describe, expect, test } from "bun:test";

import {
  invocationArgs,
  loadPolicy,
} from "../src/adapters";
import { POLICY_PATH } from "../src/catalog";
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
  command: { resource: "widgets", action: "create", canonicalAction: "create" },
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
const manifest: Manifest = {
  version: "fixture",
  operations: [operation],
};
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

describe("implementation adapters", () => {
  test("keeps semantic vectors independent from current and future argv", async () => {
    const policy = await loadPolicy(POLICY_PATH);
    const common = {
      policy,
      vector,
      manifest,
      host: "http://127.0.0.1:3000",
    };
    const current = invocationArgs({ adapter: "specli-v0", ...common });
    expect(current).toContain("--name");
    expect(current).toContain("--nested.count");
    expect(current).not.toContain("--body-json");
    const future = invocationArgs({ adapter: "contract-v1", ...common });
    expect(future).toContain("--body-json");
    expect(future).toContain('{"name":"test","nested":{"count":1}}');
  });

  test("the conformance compiler has no specli imports", async () => {
    const files = [...new Bun.Glob("conformance/src/*.ts").scanSync(".")];
    for (const file of files) {
      const source = await Bun.file(file).text();
      expect(source).not.toMatch(/from\s+["']specli(?:\/[^"']*)?["']/);
    }
  });
});

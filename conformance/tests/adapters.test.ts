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
  tags: ["Widgets"],
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
      schema: { type: "string" },
      sample: "widget-1",
    },
    {
      location: "query",
      name: "dryRun",
      cliName: "dry-run",
      required: false,
      style: "form",
      explode: true,
      schema: { type: "boolean" },
      sample: true,
    },
  ],
  requestBody: {
    required: true,
    contentType: "application/json",
    branches: [],
  },
  responses: [],
};
const manifest: Manifest = {
  schemaVersion: 1,
  version: "fixture",
  source: {
    ref: "fixture",
    commit: "0".repeat(40),
    sha256: "0".repeat(64),
    path: "fixture.yml",
  },
  openapi: "3.0.1",
  generatedAt: "deterministic",
  operations: [operation],
};
const vector: ConformanceVector = {
  schemaVersion: 1,
  id: "fixture:widgets_create:body-branch",
  version: "fixture",
  kind: "body-branch",
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
  expected: { reachesServer: true, exit: "zero" },
  covers: [],
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

import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import { prepareRequest } from "./client";
import type { ApiOperation } from "./contracts/types";

const operation: ApiOperation = {
  key: "GET /api/public/health",
  operationId: "health_get",
  method: "GET",
  path: "/api/public/health",
  auth: { required: false, schemes: [] },
  command: {
    resource: "health",
    action: "get",
  },
  pathParameterOrder: [],
  parameters: [],
};

describe("API client", () => {
  test("identifies requests with the CLI package version", () => {
    const request = prepareRequest(
      { host: "https://cloud.langfuse.com", timeoutMs: 1_000 },
      operation,
      { path: {}, query: {}, headers: {}, cookies: {} },
    );

    expect(request.headers.get("user-agent")).toBe(
      `langfuse-cli/${packageJson.version}`,
    );
  });
});

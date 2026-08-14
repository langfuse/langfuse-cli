import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertOperationCallable,
  operationByCommand,
  parseOperationInput,
  run,
  runApi,
  schemaOutput,
  writeResult,
} from "./cli";
import { compileApiContract } from "./contracts/compiler";
import type { ApiOperation } from "./contracts/types";

async function captureOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: any) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

describe("langfuse get-skill", () => {
  test("prints manual download instructions when github is blocked", async () => {
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;

    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("network blocked");
    }) as typeof fetch;

    process.exitCode = undefined;

    try {
      const output = await captureOutput(() =>
        run(["node", "langfuse", "get-skill"]),
      );

      expect(output.stdout).toBe("");
      expect(output.stderr).toContain(
        "Failed to fetch the latest Langfuse skill from GitHub.",
      );
      expect(output.stderr).toContain(
        "This environment may block direct GitHub access.",
      );
      expect(output.stderr).toContain(
        "https://raw.githubusercontent.com/langfuse/skills/main/skills/langfuse/SKILL.md",
      );
      expect(output.stderr).toContain("network blocked");
      expect(process.exitCode).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

describe("operation input parsing", () => {
  const promptGet: ApiOperation = {
    key: "GET /api/public/v2/prompts/{promptName}",
    operationId: "prompts_get",
    method: "GET",
    path: "/api/public/v2/prompts/{promptName}",
    auth: { required: false, schemes: [] },
    command: {
      resource: "prompts",
      action: "get",
    },
    pathParameterOrder: ["promptName"],
    parameters: [
      {
        location: "path",
        name: "promptName",
        cliName: "prompt-name",
        required: true,
        style: "simple",
        explode: false,
        kind: "string",
      },
      {
        location: "query",
        name: "resolve",
        cliName: "resolve",
        required: false,
        style: "form",
        explode: true,
        kind: "boolean",
      },
    ],
  };

  test("does not consume a positional after a bare boolean flag", async () => {
    const input = await parseOperationInput(promptGet, [
      "--resolve",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(true);
  });

  test("does not consume a positional after a negated boolean flag", async () => {
    const input = await parseOperationInput(promptGet, [
      "--no-resolve",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(false);
  });

  test("accepts an explicit inline boolean before a positional", async () => {
    const input = await parseOperationInput(promptGet, [
      "--resolve=false",
      "my-prompt-name",
    ]);

    expect(input.path.promptName).toBe("my-prompt-name");
    expect(input.query.resolve).toBe(false);
  });

  test("resolves contract-declared parameter flag aliases", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      parameters: [
        ...promptGet.parameters,
        {
          location: "query",
          name: "version",
          cliName: "version",
          cliAliases: ["prompt-version"],
          required: false,
          style: "form",
          explode: true,
          kind: "number",
        },
      ],
    };
    const input = await parseOperationInput(operation, [
      "my-prompt-name",
      "--prompt-version",
      "2",
    ]);

    expect(input.query.version).toBe(2);
  });

  test("preserves the item type of array request-body flags", async () => {
    const contract = compileApiContract(
      { version: "test", ref: "test", sha256: "test" },
      `openapi: 3.0.3
info:
  title: Test
  version: test
paths:
  /models:
    put:
      operationId: models_put
      tags: [Models]
      deprecated: true
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                customModels:
                  type: array
                  items:
                    type: string
      responses:
        "200":
          description: OK
`,
    );
    const operation = contract.operations[0];
    const field = operation.requestBody?.fields.find(
      (candidate) => candidate.name === "customModels",
    );

    expect(operation.deprecated).toBe(true);
    expect(field?.itemKind).toBe("string");
    expect(
      await parseOperationInput(operation, ["--customModels", "123"]),
    ).toMatchObject({ body: { customModels: ["123"] } });
  });

  test("rejects deprecated operations with replacement guidance", () => {
    const operation: ApiOperation = {
      ...promptGet,
      deprecated: true,
      description: "**Deprecated.** Use `GET /api/public/v3/prompts` instead.",
    };

    expect(() => assertOperationCallable(operation, "4.10.0")).toThrow(
      'Cannot call deprecated API operation "prompts get"',
    );
    expect(() => assertOperationCallable(operation, "4.10.0")).toThrow(
      "Use `GET /api/public/v3/prompts` instead.",
    );

    const schema = schemaOutput({
      schemaVersion: 1,
      apiVersion: "4.10.0",
      sourceSha256: "test",
      operations: [operation],
    });
    expect(schema.resources[0].actions[0].deprecated).toBe(true);
  });

  test("rejects nested body flags without consuming a positional", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "PATCH /api/public/widgets/{widgetId}",
      operationId: "widgets_update",
      method: "PATCH",
      path: "/api/public/widgets/{widgetId}",
      command: {
        resource: "widgets",
        action: "update",
      },
      pathParameterOrder: ["widgetId"],
      parameters: [
        {
          location: "path",
          name: "widgetId",
          cliName: "widget-id",
          required: true,
          style: "simple",
          explode: false,
          kind: "string",
        },
      ],
      requestBody: {
        required: true,
        contentType: "application/json",
        legacyFieldFlags: true,
        fields: [
          {
            name: "chartConfig",
            required: false,
            kind: "object",
          },
        ],
      },
    };

    await expect(
      parseOperationInput(operation, [
        "--chartConfig.show_value_labels",
        "widget-123",
      ]),
    ).rejects.toThrow(
      "Nested body option --chartConfig.show_value_labels is unsupported; pass --chartConfig with a JSON object or use --body-json",
    );

    expect(
      await parseOperationInput(operation, [
        "widget-123",
        "--chartConfig",
        '{"show_value_labels":true}',
      ]),
    ).toMatchObject({
      path: { widgetId: "widget-123" },
      body: { chartConfig: { show_value_labels: true } },
    });
  });

  test("preserves an explicit null complete body", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/widgets",
      operationId: "widgets_create",
      method: "POST",
      path: "/api/public/widgets",
      command: {
        resource: "widgets",
        action: "create",
      },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        legacyFieldFlags: false,
        fields: [],
      },
    };

    expect(await parseOperationInput(operation, ["--body-json", "null"])).toEqual({
      path: {},
      query: {},
      headers: {},
      cookies: {},
      body: null,
    });
  });

  test("uses last-wins for repeated scalar body flags and appends arrays", async () => {
    const operation: ApiOperation = {
      ...promptGet,
      key: "POST /api/public/widgets",
      operationId: "widgets_create",
      method: "POST",
      path: "/api/public/widgets",
      command: { resource: "widgets", action: "create" },
      pathParameterOrder: [],
      parameters: [],
      requestBody: {
        required: true,
        contentType: "application/json",
        legacyFieldFlags: true,
        fields: [
          { name: "content", required: true, kind: "string" },
          {
            name: "tags",
            required: false,
            kind: "array",
            itemKind: "string",
          },
        ],
      },
    };

    expect(
      await parseOperationInput(operation, [
        "--content",
        "first",
        "--content",
        "second",
        "--tags",
        "one",
        "--tags",
        "two",
      ]),
    ).toMatchObject({
      body: { content: "second", tags: ["one", "two"] },
    });
  });

  test("resolves tag and version command aliases", () => {
    const operation: ApiOperation = {
      ...promptGet,
      operationId: "scoresV3_getManyV3",
      path: "/api/public/v3/scores",
      command: {
        resource: "scores",
        action: "list",
        aliases: [
          { resource: "scores-v3", action: "list", source: "tag" },
        ],
      },
    };
    const contract = {
      schemaVersion: 1 as const,
      apiVersion: "4.10.0",
      sourceSha256: "test",
      operations: [operation],
    };

    expect(operationByCommand(contract, "scores-v3", "list")).toBe(operation);
  });
});

describe("API version reporting", () => {
  const catalog = {
    schemaVersion: 1 as const,
    latest: "4.10.0",
    versions: [
      { version: "3.150.0", sourceSha256: "old" },
      { version: "3.216.0", sourceSha256: "new" },
      { version: "4.10.0", sourceSha256: "latest" },
    ],
  };
  const config = {
    host: "http://localhost:3000",
    timeoutMs: 1_000,
    json: false,
    curl: false,
    showSecrets: false,
  };

  test("versions current prints the resolved major selection", async () => {
    const output = await captureOutput(() =>
      runApi({ ...config, apiVersion: "3" }, ["versions", "current"], catalog),
    );

    expect(output.stdout).toBe("3.216.0\n");
    expect(output.stderr).toBe("");
  });

  test("versions current resolves auto instead of echoing it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({ version: "3.216.1" })) as typeof fetch;
    try {
      const output = await captureOutput(() =>
        runApi(
          { ...config, apiVersion: "auto" },
          ["versions", "current"],
          catalog,
        ),
      );
      expect(output.stdout).toBe("3.216.0\n");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("versions current rejects invalid selectors", async () => {
    await expect(
      runApi(
        { ...config, apiVersion: "bogus" },
        ["versions", "current"],
        catalog,
      ),
    ).rejects.toThrow("Unknown API version bogus");
  });
});

describe("result output", () => {
  test("writes an empty file for an empty response body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "langfuse-cli-test-"));
    const output = join(directory, "response.json");
    try {
      await writeResult(
        { status: 204, headers: {}, body: null, ok: true },
        {
          host: "http://localhost",
          timeoutMs: 1_000,
          json: false,
          curl: false,
          showSecrets: false,
          output,
        },
      );

      expect(await Bun.file(output).text()).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

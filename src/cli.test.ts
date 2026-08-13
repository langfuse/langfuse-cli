import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOperationInput, run, writeResult } from "./cli";
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
      canonicalAction: "get",
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

    expect(field?.itemKind).toBe("string");
    expect(
      await parseOperationInput(operation, ["--customModels", "123"]),
    ).toMatchObject({ body: { customModels: ["123"] } });
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
        canonicalAction: "update",
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

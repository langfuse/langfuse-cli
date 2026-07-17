import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateVectors } from "../src/generator";
import { compileOpenApi } from "../src/openapi";
import { runConformance } from "../src/runner";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const raw = `openapi: 3.0.1
info: { title: fixture, version: '1' }
paths:
  /widgets/{id}:
    get:
      operationId: widgets_get
      tags: [Widgets]
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
        - in: query
          name: limit
          required: true
          schema: { type: integer, minimum: 1 }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties: { ok: { type: boolean } }
                required: [ok]
`;

describe("black-box conformance runner", () => {
  test("executes an external CLI and compares its captured HTTP request", async () => {
    directory = await mkdtemp(join(tmpdir(), "langfuse-cli-fake-"));
    const script = resolve(directory, "fake-cli.ts");
    await Bun.write(
      script,
      `const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const api = args.indexOf("api");
const id = args[api + 3];
const response = await fetch(
  \`\${value("--host")}/widgets/\${encodeURIComponent(id)}?limit=\${value("--limit")}\`,
);
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
process.exit(response.ok ? 0 : 1);
`,
    );
    const entry = {
      version: "fixture",
      ref: "fixture",
      commit: "0".repeat(40),
      sha256: "0".repeat(64),
    };
    const compiled = compileOpenApi(entry, raw);
    const vector = generateVectors(compiled)[0];
    const results = await runConformance({
      entry,
      manifest: compiled.manifest,
      vectors: [vector],
      adapter: "contract-v1",
      command: ["bun", script],
    });
    expect(results).toHaveLength(1);
    expect(results[0].failures).toEqual([]);
    expect(results[0].passed).toBe(true);
  });
});

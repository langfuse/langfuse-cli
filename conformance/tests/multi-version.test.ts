import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadCatalog } from "../src/catalog";
import { checkCorpus } from "../src/generator";
import { runConformance } from "../src/runner";

const VERSION_MATRIX = ["3.0.0", "3.100.0", "3.216.0"] as const;

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("multi-version black-box matrix", () => {
  test("runs a real generated request vector from three distinct OpenAPI specs", async () => {
    directory = await mkdtemp(join(tmpdir(), "langfuse-cli-version-matrix-"));
    const script = resolve(directory, "health-cli.ts");
    await Bun.write(
      script,
      `const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const api = args.indexOf("api");
if (args[api + 1] !== "healths" || args[api + 2] !== "list") {
  console.error("unexpected command");
  process.exit(2);
}
const response = await fetch(\`\${value("--host")}/api/public/health\`);
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
process.exit(response.ok ? 0 : 1);
`,
    );

    const catalog = await loadCatalog();
    const entries = VERSION_MATRIX.map((version) => {
      const entry = catalog.versions.find((candidate) => candidate.version === version);
      if (!entry) throw new Error(`missing catalog entry ${version}`);
      return entry;
    });
    expect(new Set(entries.map((entry) => entry.sha256)).size).toBe(3);

    const executed: string[] = [];
    const operationCounts: number[] = [];
    for (const entry of entries) {
      const corpus = await checkCorpus(entry);
      operationCounts.push(corpus.coverage.counts.operations);
      const vector = corpus.vectors.find(
        (candidate) =>
          candidate.operationId === "health_health" &&
          candidate.kind === "minimal-request",
      );
      expect(vector, `${entry.ref} health vector`).toBeDefined();
      const results = await runConformance({
        entry,
        manifest: corpus.compiled.manifest,
        vectors: [vector!],
        adapter: "contract-v1",
        command: ["bun", script],
      });
      expect(results).toHaveLength(1);
      expect(results[0].failures).toEqual([]);
      expect(results[0].passed).toBe(true);
      executed.push(entry.version);
    }

    expect(executed).toEqual(VERSION_MATRIX);
    expect(operationCounts).toEqual([39, 77, 113]);
  }, 30_000);
});

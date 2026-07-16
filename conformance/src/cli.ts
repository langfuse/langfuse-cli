import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadCatalog, selectEntries, syncSpecs } from "./catalog";
import { checkCorpus, writeCorpus } from "./generator";
import { runConformance } from "./runner";
import type { AdapterName } from "./adapters";
import type { VectorKind } from "./types";

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values.flatMap((value) => value.split(",")).filter(Boolean);
}

function option(args: string[], name: string): string | undefined {
  return optionValues(args, name)[0];
}

function usage(): never {
  process.stderr.write(`Usage:
  bun run conformance:sync [--version 3.216.0]
  bun run conformance:generate [--version 3.216.0]
  bun run conformance:check [--version 3.216.0]
  bun run conformance:run --version 3.216.0 --adapter specli-v0 --current-cli [filters]
  bun run conformance:run --version 3.216.0 --adapter contract-v1 [filters] -- <command...>

Run filters:
  --kind <kind[,kind]>       Restrict vector kinds
  --operation <operationId>  Restrict one operation
  --max <count>              Cap selected cases
  --fail-fast                Stop on first failure
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  const separator = args.indexOf("--");
  const controlArgs =
    command === "run" && separator !== -1 ? args.slice(0, separator) : args;
  const catalog = await loadCatalog();
  const selected = selectEntries(catalog, optionValues(controlArgs, "--version"));
  if (command === "sync") {
    await syncSpecs(selected);
    return;
  }
  if (command === "generate") {
    for (const entry of selected) {
      const corpus = await writeCorpus(entry);
      if (corpus.coverage.unsupported.length > 0) {
        throw new Error(
          `${entry.ref}: unsupported features: ${corpus.coverage.unsupported.join(", ")}`,
        );
      }
      process.stdout.write(
        `generated ${entry.ref}: ${corpus.coverage.counts.operations} operations, ${corpus.coverage.counts.vectors} vectors\n`,
      );
    }
    return;
  }
  if (command === "check") {
    for (const entry of selected) {
      const corpus = await checkCorpus(entry);
      if (corpus.coverage.unsupported.length > 0) {
        throw new Error(
          `${entry.ref}: unsupported features: ${corpus.coverage.unsupported.join(", ")}`,
        );
      }
      process.stdout.write(
        `verified ${entry.ref}: ${corpus.coverage.counts.vectors} vectors\n`,
      );
    }
    return;
  }
  if (command !== "run") usage();
  if (selected.length !== 1) {
    throw new Error("conformance:run requires exactly one --version");
  }
  const adapter = (option(controlArgs, "--adapter") ?? "contract-v1") as AdapterName;
  if (!(["specli-v0", "contract-v1"] as string[]).includes(adapter)) {
    throw new Error(`Unknown adapter: ${adapter}`);
  }
  const corpus = await checkCorpus(selected[0]);
  const kinds = new Set(optionValues(controlArgs, "--kind") as VectorKind[]);
  const operationId = option(controlArgs, "--operation");
  const max = Number(option(controlArgs, "--max") ?? Number.POSITIVE_INFINITY);
  let vectors = corpus.vectors.filter(
    (vector) =>
      (kinds.size === 0 || kinds.has(vector.kind)) &&
      (!operationId || vector.operationId === operationId),
  );
  if (Number.isFinite(max)) vectors = vectors.slice(0, max);
  const implementationCommand = separator === -1 ? undefined : args.slice(separator + 1);
  const results = await runConformance({
    entry: selected[0],
    manifest: corpus.compiled.manifest,
    vectors,
    adapter,
    command: implementationCommand,
    currentCli: controlArgs.includes("--current-cli"),
    failFast: controlArgs.includes("--fail-fast"),
  });
  const failed = results.filter((result) => !result.passed);
  const reportPath = resolve(
    "conformance",
    "reports",
    `${selected[0].version}-${adapter}.json`,
  );
  await mkdir(resolve("conformance", "reports"), { recursive: true });
  await Bun.write(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: selected[0].version,
        adapter,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed; report ${reportPath}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

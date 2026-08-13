import { loadCatalog, selectEntries, syncSpecs } from "./catalog";
import { generateCorpus } from "./generator";
import { runConformance } from "./runner";
import type { AdapterName } from "./adapters";

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
  bun run conformance:sync [--version 4.10.0]
  bun run conformance:run --version 4.10.0 --adapter specli-v0 --current-cli [filters]
  bun run conformance:run --version 4.10.0 --adapter contract-v1 [filters] -- <command...>

Run filters:
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
  if (command !== "run") usage();
  if (selected.length !== 1) {
    throw new Error("conformance:run requires exactly one --version");
  }
  const adapter = (option(controlArgs, "--adapter") ?? "contract-v1") as AdapterName;
  if (!(["specli-v0", "contract-v1"] as string[]).includes(adapter)) {
    throw new Error(`Unknown adapter: ${adapter}`);
  }
  const corpus = await generateCorpus(selected[0]);
  if (corpus.compiled.unsupported.length > 0) {
    throw new Error(
      `${selected[0].ref}: unsupported features: ${corpus.compiled.unsupported.join(", ")}`,
    );
  }
  const operationId = option(controlArgs, "--operation");
  const max = Number(option(controlArgs, "--max") ?? Number.POSITIVE_INFINITY);
  let vectors = corpus.vectors.filter(
    (vector) => !operationId || vector.operationId === operationId,
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
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

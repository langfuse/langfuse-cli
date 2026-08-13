import { loadCatalog } from "./catalog";
import { generateCorpus } from "./generator";
import { runConformance } from "./runner";

const build = Bun.spawn(["bun", "run", "build"], {
  cwd: import.meta.dir + "/../..",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);

const catalog = await loadCatalog();
let passed = 0;
let total = 0;
let failed = false;

for (const entry of catalog.versions) {
  const corpus = await generateCorpus(entry);
  const results = await runConformance({
    entry,
    manifest: corpus.compiled.manifest,
    vectors: corpus.vectors,
    adapter: "contract-v1",
    command: ["bun", "bin/langfuse.mjs", "--api-version", entry.version],
    quiet: true,
  });
  const versionPassed = results.filter((result) => result.passed).length;
  passed += versionPassed;
  total += results.length;
  process.stdout.write(`${entry.version}: ${versionPassed}/${results.length}\n`);

  for (const result of results.filter((candidate) => !candidate.passed)) {
    failed = true;
    process.stderr.write(`FAIL ${result.id}\n`);
    for (const failure of result.failures) {
      process.stderr.write(`  ${failure}\n`);
    }
    if (result.process.stderr) process.stderr.write(result.process.stderr);
  }
}

process.stdout.write(`Total: ${passed}/${total}\n`);
if (failed) process.exit(1);

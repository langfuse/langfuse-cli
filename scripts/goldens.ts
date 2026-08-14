import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadCatalog, readVerifiedSpec } from "../conformance/src/catalog";
import {
  GOLDENS_DIRECTORY,
  commandSurface,
  formatGolden,
  goldenFiles,
  goldenPath,
} from "../conformance/src/goldens";
import {
  assertOverridesApplied,
  compileApiContract,
} from "../src/contracts/compiler";
import type { ApiContract } from "../src/contracts/types";

const catalog = await loadCatalog();
const contracts: ApiContract[] = [];
for (const entry of catalog.versions) {
  const raw = await readVerifiedSpec(entry);
  const contract = compileApiContract(entry, raw);
  contracts.push(contract);
  const path = goldenPath(entry.version);
  const content = formatGolden(commandSurface(contract.operations));
  const existing = Bun.file(path);
  if ((await existing.exists()) && (await existing.text()) === content) {
    process.stdout.write(`unchanged ${path}\n`);
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
  process.stdout.write(`wrote ${path}\n`);
}

assertOverridesApplied(contracts);

const expected = new Set(catalog.versions.map((entry) => `${entry.version}.json`));
for (const file of await goldenFiles()) {
  if (!expected.has(file)) {
    await rm(resolve(GOLDENS_DIRECTORY, file));
    process.stdout.write(`removed orphaned ${file}\n`);
  }
}

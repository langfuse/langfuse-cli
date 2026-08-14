import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadCatalog, readVerifiedSpec } from "../conformance/src/catalog";
import {
  commandSurface,
  formatGolden,
  goldenPath,
} from "../conformance/src/goldens";
import { compileApiContract } from "../src/contracts/compiler";

const catalog = await loadCatalog();
for (const entry of catalog.versions) {
  const raw = await readVerifiedSpec(entry);
  const contract = compileApiContract(entry, raw);
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

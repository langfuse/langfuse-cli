import { describe, expect, test } from "bun:test";

import { compileApiContract } from "../../src/contracts/compiler";
import { loadCatalog, readVerifiedSpec } from "../src/catalog";
import { commandSurface, loadGoldenSurface } from "../src/goldens";

describe("pinned command surface", () => {
  test("every snapshot matches its committed command golden", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const raw = await readVerifiedSpec(entry);
      const contract = compileApiContract(entry, raw);
      // A mismatch means the user-facing command surface changed. If the
      // change is intentional, run `bun run goldens:update` and review the
      // golden diff instead of editing goldens by hand.
      expect({
        version: entry.version,
        surface: commandSurface(contract.operations),
      }).toEqual({
        version: entry.version,
        surface: await loadGoldenSurface(entry.version),
      });
    }
  });
});

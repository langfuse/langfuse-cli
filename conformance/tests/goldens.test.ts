import { describe, expect, test } from "bun:test";

import {
  assertOverridesApplied,
  compileApiContract,
} from "../../src/contracts/compiler";
import type { ApiContract } from "../../src/contracts/types";
import { loadCatalog, readVerifiedSpec } from "../src/catalog";
import { goldenFiles, goldenSurfaceDiff } from "../src/goldens";

describe("pinned command surface", () => {
  test("every snapshot matches its committed command golden", async () => {
    const catalog = await loadCatalog();
    const contracts: ApiContract[] = [];
    for (const entry of catalog.versions) {
      const raw = await readVerifiedSpec(entry);
      const contract = compileApiContract(entry, raw);
      contracts.push(contract);
      // A difference means the user-facing command surface changed. If the
      // change is intentional, run `bun run goldens:update` and review the
      // golden diff instead of editing goldens by hand.
      expect(await goldenSurfaceDiff(entry.version, contract.operations)).toEqual(
        [],
      );
    }
    // Every overrides.json entry must be applied in at least one snapshot,
    // so stale keys cannot rot silently.
    expect(() => assertOverridesApplied(contracts)).not.toThrow();
  });

  test("the goldens directory matches the catalog exactly", async () => {
    const catalog = await loadCatalog();
    expect(await goldenFiles()).toEqual(
      catalog.versions
        .map((entry) => `${entry.version}.json`)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
});

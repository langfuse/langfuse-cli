import { describe, expect, test } from "bun:test";

import {
  compareVersions,
  formatCatalog,
  normalizeReleaseTag,
  updateConformanceReadme,
  withCatalogEntry,
} from "../src/add-version";
import type { Catalog, CatalogEntry } from "../src/types";

const entry = (version: string): CatalogEntry => ({
  version,
  ref: `v${version}`,
  commit: version.replaceAll(".", "").padEnd(40, "0"),
  sha256: version.replaceAll(".", "").padEnd(64, "0"),
});

describe("add-version workflow", () => {
  test("normalizes only stable semantic release tags", () => {
    expect(normalizeReleaseTag("v4.10.0")).toEqual({
      tag: "v4.10.0",
      version: "4.10.0",
    });
    expect(normalizeReleaseTag("4.011.0")).toEqual({
      tag: "v4.11.0",
      version: "4.11.0",
    });
    expect(() => normalizeReleaseTag("v4.11.0-rc.1")).toThrow(
      "Expected a stable release tag",
    );
  });

  test("inserts catalog entries in semantic order and rejects duplicates", () => {
    const catalog: Catalog = {
      schemaVersion: 1,
      repository: "https://github.com/langfuse/langfuse",
      specPath: "openapi.yml",
      versions: [entry("3.216.0"), entry("4.10.0")],
    };
    const updated = withCatalogEntry(catalog, entry("4.9.0"));
    expect(updated.versions.map((item) => item.version)).toEqual([
      "3.216.0",
      "4.9.0",
      "4.10.0",
    ]);
    expect(compareVersions("4.10.0", "4.9.0")).toBeGreaterThan(0);
    expect(() => withCatalogEntry(updated, entry("4.10.0"))).toThrow(
      "already present",
    );
    expect(formatCatalog({
      ...updated,
      versions: [{ ...entry("4.10.0"), knownIssues: ["known-issue"] }],
    })).toContain('"knownIssues": ["known-issue"]');
  });

  test("regenerates both operation totals and the pinned-spec table", () => {
    const input = `The suite currently attempts all 10 operations across 2 snapshots using X.
The native adapter checks all 10 operations through JSON.

| Langfuse | Paths | Operations |
|---|---:|---:|
| 1.0.0 | 1 | 4 |
| 2.0.0 | 2 | 6 |

After table.
`;
    const updated = updateConformanceReadme(input, [
        { version: "1.0.0", paths: 1, operations: 4 },
        { version: "2.0.0", paths: 2, operations: 6 },
        { version: "3.0.0", paths: 3, operations: 8 },
      ]);
    expect(updated).toContain("all 18 operations across 3 pinned snapshots");
    expect(updated).toContain("checks all 18 operations through");
    expect(updateConformanceReadme(input, [
      { version: "3.0.0", paths: 3, operations: 8 },
    ])).toContain("| 3.0.0 | 3 | 8 |");
  });

  test("fails loudly when tracked README wording drifts", () => {
    const input = `The suite currently attempts all 10 operations across 1 snapshots using X.
The native adapter runs every operation through JSON.

| Langfuse | Paths | Operations |
|---|---:|---:|
| 1.0.0 | 1 | 10 |

After table.
`;
    expect(() =>
      updateConformanceReadme(input, [
        { version: "1.0.0", paths: 1, operations: 10 },
      ]),
    ).toThrow("Could not find native adapter operation count");
  });
});

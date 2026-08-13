import { describe, expect, test } from "bun:test";

import { resolveContractVersion } from "./loader";
import type { ApiContractCatalog } from "./types";

const catalog: ApiContractCatalog = {
  schemaVersion: 1,
  latest: "4.10.0",
  versions: [
    { version: "3.216.0", sourceSha256: "3-latest" },
    { version: "4.10.0", sourceSha256: "4-latest" },
    { version: "3.0.0", sourceSha256: "3-oldest" },
    { version: "3.150.0", sourceSha256: "3-middle" },
  ],
};

function resolve(requested: string) {
  return resolveContractVersion({
    requested,
    host: "http://localhost:3000",
    timeoutMs: 1_000,
    catalog,
  });
}

describe("API contract version resolution", () => {
  test.each(["3", "v3", "3.x", "v3.x"])(
    "resolves major selector %s to the latest bundled v3 contract",
    async (requested) => {
      expect((await resolve(requested)).version).toBe("3.216.0");
    },
  );

  test("resolves another major independently", async () => {
    expect((await resolve("4")).version).toBe("4.10.0");
  });

  test("keeps exact selection exact", async () => {
    expect((await resolve("3.150.0")).version).toBe("3.150.0");
  });

  test("reports unavailable major selectors", async () => {
    await expect(resolve("5")).rejects.toThrow(
      "No bundled API contract for major version 5. Available majors: 3, 4",
    );
  });
});

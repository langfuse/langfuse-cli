import { describe, expect, spyOn, test } from "bun:test";

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

function resolve(requested?: string, host = "http://localhost:3000") {
  return resolveContractVersion({
    requested,
    host,
    timeoutMs: 1_000,
    catalog,
  });
}

describe("API contract version resolution", () => {
  test.each([
    "https://cloud.langfuse.com",
    "https://us.cloud.langfuse.com",
    "https://jp.cloud.langfuse.com",
    "https://hipaa.cloud.langfuse.com",
    "https://JP.CLOUD.LANGFUSE.COM.:443/",
  ])("rejects v3 on %s", async (host) => {
    await expect(resolve("3.150.0", host)).rejects.toThrow("Cloud does not support v3");
  });

  test("rejects auto-detected v3 on Cloud", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: "3.216.1" }));
    try {
      await expect(resolve("auto", "https://cloud.langfuse.com")).rejects.toThrow("Cloud does not support v3");
    } finally {
      fetch.mockRestore();
    }
  });

  test("rejects a v3 default snapshot on Cloud", async () => {
    await expect(resolveContractVersion({
      host: "https://cloud.langfuse.com",
      timeoutMs: 1_000,
      catalog: { ...catalog, latest: "3.216.0" },
    })).rejects.toThrow("Cloud does not support v3");
  });

  test.each(["3", "v3", "3.x", "v3.x"])(
    "resolves major selector %s to the latest bundled v3 contract",
    async (requested) => {
      expect((await resolve(requested)).version).toBe("3.216.0");
      await expect(resolve(requested, "https://cloud.langfuse.com")).rejects.toThrow("Cloud does not support v3");
    },
  );

  test("resolves another major independently", async () => {
    expect((await resolve("4")).version).toBe("4.10.0");
    expect((await resolve("latest", "https://cloud.langfuse.com")).version).toBe("4.10.0");
  });

  test("keeps exact selection exact", async () => {
    expect((await resolve("3.150.0")).version).toBe("3.150.0");
    expect((await resolve("3.150.0", "https://cloud.langfuse.com.example.com")).version).toBe("3.150.0");
  });

  test("reports unavailable major selectors", async () => {
    await expect(resolve("5")).rejects.toThrow(
      "No bundled API contract for major version 5. Available majors: 3, 4",
    );
  });
});

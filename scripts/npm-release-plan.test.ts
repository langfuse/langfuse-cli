import { describe, expect, test } from "bun:test";

import { npmReleasePlan, type NpmRegistryPackageState } from "./npm-release-plan";

const releaseSha = "a".repeat(40);

function state(
  name: string,
  currentDistTags: Record<string, string> | null,
  publishedGitHead: string | null = null,
): NpmRegistryPackageState {
  return { name, currentDistTags, publishedGitHead };
}

function plan(
  canonical: NpmRegistryPackageState,
  legacy: NpmRegistryPackageState,
) {
  return npmReleasePlan({
    version: "1.3.0",
    tagName: "v1.3.0",
    isPrerelease: false,
    releaseSha,
    packages: { canonical, legacy },
  });
}

describe("dual npm release plan", () => {
  test("publishes both packages when the release is new", () => {
    const result = plan(
      state("@langfuse/cli", null),
      state("langfuse-cli", { latest: "1.2.0" }),
    );
    expect(result.distTag).toBe("latest");
    expect(result.packages.canonical.status).toBe("publish");
    expect(result.packages.legacy.status).toBe("publish");
  });

  test("resumes a partial publish from the same release commit", () => {
    const result = plan(
      state("@langfuse/cli", { latest: "1.3.0" }, releaseSha),
      state("langfuse-cli", { latest: "1.2.0" }),
    );
    expect(result.packages.canonical.status).toBe("already-published");
    expect(result.packages.legacy.status).toBe("publish");
  });

  test("refuses an existing version from another commit", () => {
    expect(() =>
      plan(
        state("@langfuse/cli", { latest: "1.3.0" }, "b".repeat(40)),
        state("langfuse-cli", { latest: "1.2.0" }),
      ),
    ).toThrow("already exists from git head");
  });

  test("refuses a new release while package dist-tags are divergent", () => {
    expect(() =>
      plan(
        state("@langfuse/cli", { latest: "1.2.0" }),
        state("langfuse-cli", { latest: "1.1.0" }),
      ),
    ).toThrow("recover the previous dual publish");
  });

  test("keeps monotonicity checks for either package", () => {
    expect(() =>
      plan(
        state("@langfuse/cli", { latest: "2.0.0" }),
        state("langfuse-cli", { latest: "2.0.0" }),
      ),
    ).toThrow("backwards");
  });
});

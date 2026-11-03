import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  test("release entry point rejects stale channels and old npm before changing files or running gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-release-preflight-"));
    try {
      await cp(import.meta.dir, join(root, "scripts"), { recursive: true });
      await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
      const original = JSON.stringify({ name: "@langfuse/cli", version: "1.3.0" });
      await writeFile(join(root, "package.json"), original);
      const preload = join(root, "commands.ts");
      await writeFile(preload, `
        Object.defineProperty(process.stdin, "isTTY", { value: true });
        const outputs = JSON.parse(process.env.RELEASE_TEST_OUTPUTS);
        Bun.spawn = (command) => {
          const key = command.join(" ");
          if (!Object.hasOwn(outputs, key)) throw new Error("Unexpected command: " + key);
          return { exited: Promise.resolve(0), stdout: new Blob([outputs[key]]).stream(), stderr: new Blob([]).stream() };
        };
      `);
      for (const scenario of [
        { version: "1.4.0-beta.3", canonical: { beta: "1.4.0-beta.19000000000" }, legacy: { beta: "1.4.0-beta.19000000000" }, local: false, error: "backwards" },
        { version: "1.4.0", canonical: { latest: "1.3.0" }, legacy: { latest: "1.2.4" }, local: false, error: "recover the previous dual publish" },
        { version: "1.4.0", canonical: {}, legacy: {}, local: true, error: "need >= 11.15.0" },
      ]) {
        const outputs: Record<string, string> = {
          "git status --porcelain=v1 --untracked-files=all": "",
          "git rev-parse HEAD": releaseSha,
          "npm --version": "11.14.0",
          "npm view @langfuse/cli versions dist-tags --json": JSON.stringify({ versions: ["1.3.0"], "dist-tags": scenario.canonical }),
          "npm view langfuse-cli versions dist-tags --json": JSON.stringify({ versions: ["1.3.0"], "dist-tags": scenario.legacy }),
        };
        const proc = Bun.spawn([
          process.execPath, "--preload", preload, join(root, "scripts/release.ts"),
          "--dry-run", "--version", scenario.version, ...(scenario.local ? ["--publish-local"] : []),
        ], {
          cwd: root, env: { ...process.env, RELEASE_TEST_OUTPUTS: JSON.stringify(outputs) },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        expect(status).toBe(1);
        expect(stderr).toContain(scenario.error);
        expect(stdout).not.toContain("Updated package.json");
        expect(await Bun.file(join(root, "package.json")).text()).toBe(original);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

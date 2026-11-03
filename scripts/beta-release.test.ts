import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { betaPublishPlan, betaReleasePlan, type BetaRegistryPackage } from "./beta-release";

const releaseSha = "a".repeat(40);
const previousSha = "b".repeat(40);

function registry(
  beta?: string,
  versions: Record<string, { gitHead?: string }> = {},
  latest = "1.2.4",
): BetaRegistryPackage {
  return { distTags: { latest, ...(beta ? { beta } : {}) },
    versions: { ...(beta ? { [beta]: { gitHead: previousSha } } : {}), ...versions } };
}

function plan(
  metadata = registry(),
  version = "1.2.4",
  runId = "100",
) {
  return betaReleasePlan({ version, releaseSha, registry: metadata, runId });
}

describe("beta releases", () => {
  test("checks the selected beta version, source identity, tag, and monotonicity", () => {
    const input = { version: "1.2.5-beta.0", releaseSha, registry: registry() };
    expect(betaPublishPlan(input).version).toBe(input.version);
    expect(() => betaPublishPlan({ ...input, tagName: "v1.2.5-beta.1" })).toThrow("does not match");
    expect(() => betaPublishPlan({ ...input, version: "1.2.5" })).toThrow("requires a beta version");
    expect(() => betaPublishPlan({
      ...input, registry: registry("1.2.5-beta.1"),
    })).toThrow("backwards");
    expect(() => betaPublishPlan({
      ...input, registry: registry(undefined, { [input.version]: { gitHead: previousSha } }),
    })).toThrow("different or missing gitHead");
    expect(betaPublishPlan({
      ...input, registry: registry("1.2.5-beta.1", { [input.version]: { gitHead: releaseSha } }),
    }).packages.canonical.status).toBe("already-published");
  });

  test("reserves unique beta versions even when no pending stage is publicly visible", () => {
    expect(plan().version).toBe("1.3.0-beta.100");
    expect(plan(registry(), "1.2.4", "101").version).toBe("1.3.0-beta.101");
    expect(plan(registry(), "2.2.4").version).toBe("2.3.0-beta.100");
    expect(plan(registry(), "2.0.0-beta.4").version).toBe("2.0.0-beta.100");
    expect(Object.keys(plan().packages)).toEqual(["canonical"]);
    expect(plan().distTag).toBe("beta");
  });

  test("keeps this run's version across registry changes and detects stale or conflicting releases", () => {
    const previous = registry("1.3.0-beta.99", { "1.3.0-beta.99": { gitHead: releaseSha } });
    expect(plan(previous).version).toBe("1.3.0-beta.100");
    expect(plan(previous).packages.canonical.status).toBe("publish");
    expect(plan(registry("1.3.0-beta.99", {}, "1.3.0")).version).toBe("1.3.0-beta.100");
    expect(plan(registry("1.3.0-beta.101", { "1.3.0-beta.100": { gitHead: releaseSha } }))
      .packages.canonical.status).toBe("already-published");
    expect(() => plan(registry("1.3.0-beta.101"))).toThrow("backwards");
    expect(() => plan(registry(undefined, { "1.3.0-beta.100": { gitHead: previousSha } })))
      .toThrow("different or missing gitHead");
  });

  test("rejects malformed run IDs and unsupported bases", () => {
    for (const id of ["", "0", "01", "-1", "NaN", "9007199254740992", "100\n"]) {
      expect(() => plan(registry(), "1.2.4", id)).toThrow("run ID");
    }
    expect(() => plan(registry(), "1.3.0-rc.0")).toThrow("stable or beta");
    expect(() => plan(registry(undefined, {}, "1.3.0-beta.1"))).toThrow("latest must be a stable");
    expect(() => plan(registry("1.3.0-beta.1", { "1.3.0-beta.1": {} }))).toThrow("gitHead");
    expect(() => plan(registry("1.3.0"))).toThrow("beta must point to a beta version");
  });
});

async function withFixture(run: (fixture: {
  root: string;
  firstSha: string;
  lastSha: string;
  git: (...args: string[]) => string;
  execute: (metadata: BetaRegistryPackage, sha: string, args?: string[], overrides?: Record<string, string>) => Promise<{
    status: number; stdout: string; stderr: string;
  }>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cli-beta-test-"));
  try {
    await cp(import.meta.dir, join(root, "scripts"), { recursive: true });
    await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@langfuse/cli", version: "1.2.4" }));
    await writeFile(join(root, ".gitignore"), "node_modules\nmetadata.json\nregistry.ts\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-b", "beta");
    git("config", "user.name", "Beta Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "fixture");
    const firstSha = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-m", "next merge");
    const lastSha = git("rev-parse", "HEAD");
    const preload = join(root, "registry.ts");
    await writeFile(preload, `
      const metadata = await Bun.file(${JSON.stringify(join(root, "metadata.json"))}).json();
      globalThis.fetch = async (url) => {
        if (String(url) !== "https://registry.npmjs.org/%40langfuse%2Fcli") {
          throw new Error("Beta releases must only read the canonical npm registry package");
        }
        return Response.json({ "dist-tags": metadata.distTags, versions: metadata.versions });
      };
    `);
    const execute = async (
      metadata: BetaRegistryPackage,
      sha: string,
      args: string[] = [],
      overrides: Record<string, string> = {},
    ) => {
      await writeFile(join(root, "metadata.json"), JSON.stringify(metadata));
      const proc = Bun.spawn([process.execPath, "--preload", preload, join(root, "scripts/beta-release.ts"), ...args], {
        cwd: root,
        env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/test", GITHUB_SHA: sha, GITHUB_RUN_ID: "100", ...overrides },
        stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      return { status, stdout, stderr };
    };
    await run({ root, firstSha, lastSha, git, execute });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("beta workflow entry point", () => {
  test("allows manual beta releases from unrelated branches", async () => {
    await withFixture(async ({ firstSha, lastSha, git, execute }) => {
      const metadata = (sha: string) => registry("1.3.0-beta.0", {
        "1.3.0-beta.0": { gitHead: sha },
      });
      const next = await execute(metadata(firstSha), lastSha);
      expect(next.status).toBe(0);
      expect(next.stdout).toBe("version=1.3.0-beta.100\nskip=false\n");
      git("checkout", "--orphan", "unrelated");
      git("commit", "-m", "unrelated history");
      const unrelated = await execute(metadata(firstSha), git("rev-parse", "HEAD"));
      expect(unrelated.status).toBe(0);
      expect(unrelated.stdout).toBe("version=1.3.0-beta.100\nskip=false\n");
    });
  });

  test("enforces beta versions and leaves Git unchanged", async () => {
    await withFixture(async ({ root, firstSha, lastSha, git, execute }) => {
      const planned = await execute(registry(), lastSha);
      expect(planned.status).toBe(0);
      expect(planned.stdout).toBe("version=1.3.0-beta.100\nskip=false\n");
      const stable = await execute(registry(), lastSha, ["--apply"], { BETA_VERSION: "1.2.5" });
      expect(stable.status).toBe(1);
      expect((await Bun.file(join(root, "package.json")).json()).version).toBe("1.2.4");
      const beta = await execute(registry(), lastSha, ["--apply"], { BETA_VERSION: "1.2.5-beta.0" });
      expect(beta.status).toBe(0);
      expect((await Bun.file(join(root, "package.json")).json()).version).toBe("1.2.5-beta.0");
      const checked = await execute(registry(), lastSha, ["--plan"], {
        TAG_NAME: "v1.2.5-beta.0", IS_PRERELEASE: "true",
      });
      expect(checked.status).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        version: "1.2.5-beta.0", distTag: "beta",
        packages: { canonical: { name: "@langfuse/cli", status: "publish" } },
      });
      const invalidFlag = await execute(registry(), lastSha, ["--plan"], {
        TAG_NAME: "v1.2.5-beta.0", IS_PRERELEASE: "false",
      });
      expect(invalidFlag.status).toBe(1);
      expect(invalidFlag.stderr).toContain("IS_PRERELEASE=true");
      expect(git("rev-parse", "HEAD")).toBe(lastSha);
      expect(git("rev-parse", "HEAD~1")).toBe(firstSha);
      expect(git("tag", "--list")).toBe("");
    });
  });
});

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
  return { distTags: { latest, ...(beta ? { beta } : {}) }, versions };
}

function plan(
  metadata = registry(),
  version = "1.2.4",
) {
  return betaReleasePlan({ version, releaseSha, registry: metadata });
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

  test("starts the next minor beta without touching latest", () => {
    const result = plan();
    expect(result.version).toBe("1.3.0-beta.0");
    expect(plan(registry(), "2.2.4").version).toBe("2.3.0-beta.0");
    expect(result.distTag).toBe("beta");
    expect(result.packages.canonical.status).toBe("publish");
    expect(Object.keys(result.packages)).toEqual(["canonical"]);
  });

  test("increments past all existing betas, including versions off the channel", () => {
    const current = registry("1.3.0-beta.2", {
      "1.3.0-beta.2": { gitHead: previousSha },
      "1.3.0-beta.4": { gitHead: "c".repeat(40) },
    });
    expect(plan(current).version).toBe("1.3.0-beta.5");
  });

  test("advances beyond stable releases and allows an explicit beta base", () => {
    const current = registry("1.2.5-beta.0", {
      "1.2.5-beta.0": { gitHead: previousSha },
    }, "1.3.0");
    expect(plan(current).version).toBe("1.4.0-beta.0");
    expect(plan(current, "2.0.0-beta.0").version).toBe("2.0.0-beta.0");
  });

  test("reuses the same version after a publish succeeds", () => {
    const canonical = registry("1.2.5-beta.0", {
      "1.2.5-beta.0": { gitHead: releaseSha },
    });
    const result = plan(canonical);
    expect(result.version).toBe("1.2.5-beta.0");
    expect(result.packages.canonical.status).toBe("already-published");
  });

  test("recognizes an old successful run after beta has advanced", () => {
    const current = registry("1.2.5-beta.1", {
      "1.2.5-beta.0": { gitHead: releaseSha },
      "1.2.5-beta.1": { gitHead: previousSha },
    });
    const result = plan(current);
    expect(result.version).toBe("1.2.5-beta.0");
    expect(result.packages.canonical.status).toBe("already-published");
  });

  test("refuses non-beta package bases and missing published commit metadata", () => {
    expect(() => plan(registry(), "1.3.0-rc.0")).toThrow("stable or beta");
    expect(() => plan(registry("1.2.5-beta.0", {
      "1.2.5-beta.0": {},
    }))).toThrow("gitHead");
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
        env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/test", GITHUB_SHA: sha, ...overrides },
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
      expect(next.stdout).toBe("version=1.3.0-beta.1\nskip=false\n");
      git("checkout", "--orphan", "unrelated");
      git("commit", "-m", "unrelated history");
      const unrelated = await execute(metadata(firstSha), git("rev-parse", "HEAD"));
      expect(unrelated.status).toBe(0);
      expect(unrelated.stdout).toBe("version=1.3.0-beta.1\nskip=false\n");
    });
  });

  test("enforces beta versions and leaves Git unchanged", async () => {
    await withFixture(async ({ root, firstSha, lastSha, git, execute }) => {
      const planned = await execute(registry(), lastSha);
      expect(planned.status).toBe(0);
      expect(planned.stdout).toBe("version=1.3.0-beta.0\nskip=false\n");
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

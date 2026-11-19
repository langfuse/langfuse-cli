import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prerelease } from "semver";
import { assertReleasableVersion } from "./release-config";

export type ReleaseCommand = (
  command: string,
  args: string[],
  options?: { capture?: boolean; throwOnError?: boolean },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function releaseBranch(version: string): string {
  return `nimarc/release-v${assertReleasableVersion(version)}`;
}

export async function prepareReleasePullRequest(
  run: ReleaseCommand,
  version: string,
  onCommitted: () => void,
): Promise<string> {
  const tag = `v${version}`;
  const branch = releaseBranch(version);
  const git = async (...args: string[]) => (await run("git", args, { capture: true })).stdout.trim();
  const originalBranch = await git("branch", "--show-current");
  const originalHead = await git("rev-parse", "HEAD");
  await run("git", ["switch", "-c", branch]);
  try {
    // Preserve unrelated staged work; only the version bump belongs in this PR.
    await run("git", ["commit", "--only", "-m", `chore(release): ${tag}`, "--", "package.json"]);
  } catch (error) {
    // A hook/signing failure must not strand an empty branch that blocks retry.
    // Only remove the branch we just created, if it has not moved.
    if (await git("branch", "--show-current") === branch && await git("rev-parse", "HEAD") === originalHead) {
      await run("git", ["switch", originalBranch]);
      await run("git", ["update-ref", "-d", `refs/heads/${branch}`, originalHead]);
    }
    throw error;
  }
  onCommitted();
  return resumeReleasePullRequest(run, version);
}

// Also handles retrying a failed push or PR creation, without another commit.
export async function resumeReleasePullRequest(run: ReleaseCommand, version: string): Promise<string> {
  const git = async (...args: string[]) => (await run("git", args, { capture: true })).stdout.trim();
  const branch = releaseBranch(version);
  if (await git("branch", "--show-current") !== branch) {
    throw new Error(`Resume from ${branch}; no commit or branch was changed.`);
  }
  await git("fetch", "--no-tags", "origin", "main");
  await git("merge-base", "--is-ancestor", "HEAD^", "origin/main");
  if (await git("diff", "HEAD^", "HEAD", "--name-only") !== "package.json") {
    throw new Error("The release commit must change only package.json.");
  }
  const { version: previousVersion, ...previous } = JSON.parse(await git("show", "HEAD^:package.json"));
  const { version: currentVersion, ...current } = JSON.parse(await git("show", "HEAD:package.json"));
  if (currentVersion !== version || previousVersion === version || !isDeepStrictEqual(previous, current)) {
    throw new Error(`The release commit must change only the package.json version to ${version}.`);
  }
  if (await git("diff", "HEAD", "--", "package.json")) {
    throw new Error("package.json has uncommitted changes; restore or stash them before resuming.");
  }
  const head = await git("rev-parse", "HEAD");
  const result = await run("gh", ["pr", "list", "--head", branch, "--base", "main", "--state", "all", "--json", "url,state,headRefOid"], { capture: true });
  const pulls = JSON.parse(result.stdout) as { url: string; state: string; headRefOid: string }[];
  if (pulls.length > 1) throw new Error(`Multiple release PRs for ${branch}; inspect them before retrying.`);
  const existing = pulls[0];
  if (existing && (existing.headRefOid !== head || existing.state === "CLOSED")) {
    throw new Error(`Release PR conflicts with this commit: ${existing.url}`);
  }
  if (existing?.state === "MERGED") return existing.url;

  // Disable push.followTags even if configured globally. No main/tag push here.
  await run("git", ["push", "--no-follow-tags", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
  if (existing) return existing.url;

  const directory = await mkdtemp(join(tmpdir(), "langfuse-release-pr-"));
  try {
    const bodyFile = join(directory, "body.md");
    await Bun.write(bodyFile, `Bump the CLI version to ${version} for the next release.\n\nAfter merging and passing main CI, run:\n\n\`\`\`sh\ngit switch main\ngit pull --ff-only\nbun run release -- --finalize --version ${version}\n\`\`\`\n\nFinalization creates a draft release from the checked main commit. GitHub environment and npm approvals remain separate.\n`);
    return (await run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore(release): v${version}`, "--body-file", bodyFile], { capture: true })).stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const REQUIRED_RELEASE_CHECKS = [
  "Test and verify OpenAPI conformance",
  "Check GitHub Actions security",
] as const;

export interface ReleaseCheck {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { id: number } | null;
}

export function assertRequiredReleaseChecks(sha: string, checks: ReleaseCheck[]): void {
  const failures = REQUIRED_RELEASE_CHECKS.flatMap((name) => {
    // GitHub Actions app ID; a similarly named check from another app is not CI.
    const check = checks.filter((check) => check.name === name && check.app?.id === 15368)
      .sort((a, b) => b.id - a.id)[0];
    if (!check) return [`${name}: missing`];
    if (check.head_sha !== sha) return [`${name}: wrong commit`];
    if (check.status !== "completed" || check.conclusion !== "success") {
      return [`${name}: ${check.conclusion ?? check.status}`];
    }
    return [];
  });
  if (failures.length) {
    throw new Error(`Required CI is not green on ${sha.slice(0, 7)}:\n${failures.join("\n")}\nWait for successful main CI, then retry.`);
  }
}

export async function assertCiGreen(run: ReleaseCommand, sha: string): Promise<void> {
  const result = await run("gh", ["api", "--paginate", "--slurp", `repos/{owner}/{repo}/commits/${sha}/check-runs?filter=latest&per_page=100`], { capture: true });
  const pages = JSON.parse(result.stdout) as { check_runs: ReleaseCheck[] }[];
  assertRequiredReleaseChecks(sha, pages.flatMap((page) => page.check_runs));
}

// GitHub creates the tag from this exact commit when the draft is published.
// Rerunning finalization reuses a matching draft; it never moves an existing tag.
export async function createDraftRelease(
  run: ReleaseCommand,
  version: string,
  sha: string,
  dryRun = false,
): Promise<string> {
  const tag = `v${assertReleasableVersion(version)}`;
  const pkg = JSON.parse((await run("git", ["show", `${sha}:package.json`], { capture: true })).stdout);
  if (pkg.version !== version) throw new Error(`Commit ${sha.slice(0, 7)} contains version ${pkg.version}, not ${version}.`);
  await assertCiGreen(run, sha);
  const refs = (await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { capture: true })).stdout.trim();
  const remoteTag = new Map(refs.split("\n").filter(Boolean).map((line) => {
    const [oid, ref] = line.split(/\s+/);
    return [ref!, oid!] as const;
  }));
  const taggedSha = remoteTag.get(`refs/tags/${tag}^{}`) ?? remoteTag.get(`refs/tags/${tag}`);
  if (taggedSha && taggedSha !== sha) throw new Error(`Remote tag ${tag} points to ${taggedSha}, not ${sha}; refusing to move it.`);

  const result = await run("gh", ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100"], { capture: true });
  const releases = (JSON.parse(result.stdout) as {
    tag_name: string; draft: boolean; prerelease: boolean; target_commitish: string; html_url: string;
  }[][]).flat().filter((release) => release.tag_name === tag);
  if (releases.length > 1) throw new Error(`Multiple releases for ${tag}; inspect them before retrying.`);
  const existing = releases[0];
  const isPrerelease = prerelease(version) !== null;
  if (existing) {
    if (!existing.draft) throw new Error(`${tag} is already published: ${existing.html_url}`);
    if (existing.target_commitish !== sha || existing.prerelease !== isPrerelease) {
      throw new Error(`Existing draft does not match this release: ${existing.html_url}`);
    }
    return existing.html_url;
  }
  if (dryRun) return `Would create draft ${tag} from ${sha}.`;
  const args = ["release", "create", tag, "--target", sha, "--draft", "--generate-notes", "--title", tag];
  if (isPrerelease) args.push("--prerelease");
  return (await run("gh", args, { capture: true })).stdout.trim();
}

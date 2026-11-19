import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRequiredReleaseChecks,
  createDraftRelease,
  prepareReleasePullRequest,
  REQUIRED_RELEASE_CHECKS,
  resumeReleasePullRequest,
  type ReleaseCheck,
  type ReleaseCommand,
} from "./release-workflow";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "release-workflow-test-"));
  directories.push(directory);
  const remote = join(directory, "origin.git");
  const cwd = join(directory, "repo");
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release@example.invalid",
  };
  const command: ReleaseCommand = async (name, args, options) => {
    const process = Bun.spawn([name, ...args], {
      cwd: name === "git" && args[0] === "init" ? directory : cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
    if (exitCode && options?.throwOnError !== false) throw new Error(stderr);
    return { stdout, stderr, exitCode };
  };
  const git = async (...args: string[]) => (await command("git", args)).stdout.trim();
  await git("init", "--bare", remote);
  await git("init", "-b", "main", cwd);
  await Bun.write(join(cwd, "package.json"), '{"name":"test-cli","version":"1.0.0"}\n');
  await git("add", "package.json");
  await git("commit", "-m", "initial");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  const initialSha = await git("rev-parse", "HEAD");
  const hook = join(remote, "hooks", "pre-receive");
  await Bun.write(hook, '#!/bin/sh\nwhile read old new ref; do\n case "$ref" in refs/heads/main|refs/tags/*) echo "Changes must be made through a pull request" >&2; exit 1;; esac\ndone\n');
  await chmod(hook, 0o755);
  // A developer's push.followTags setting must not leak unpublished tags.
  await git("config", "push.followTags", "true");
  await git("tag", "-a", "v0.9.0", "-m", "unpublished tag");
  return { cwd, remote, initialSha, command, git };
}

test("recovers a failed commit, then opens a PR without pushing main, tags, or unrelated staged files", async () => {
  const f = await fixture();
  await Bun.write(join(f.cwd, "notes.txt"), "unrelated staged work\n");
  await f.git("add", "notes.txt");
  await Bun.write(join(f.cwd, "notes.txt"), "unrelated unstaged work\n");
  await Bun.write(join(f.cwd, "package.json"), '{"name":"test-cli","version":"1.1.0"}\n');
  const run: ReleaseCommand = async (command, args, options) => {
    if (command === "git") return f.command(command, args, options);
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { stdout: "[]", stderr: "", exitCode: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://github.com/example/cli/pull/1\n", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const hook = join(f.cwd, ".git", "hooks", "pre-commit");
  await Bun.write(hook, '#!/bin/sh\necho "Commit hook failed" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  let committed = false;
  await expect(prepareReleasePullRequest(run, "1.1.0", () => { committed = true; })).rejects.toThrow("Commit hook failed");
  expect(committed).toBe(false);
  expect(await f.git("branch", "--show-current")).toBe("main");
  expect(await f.git("branch", "--list", "nimarc/release-v1.1.0")).toBe("");
  expect(await f.git("show", ":notes.txt")).toBe("unrelated staged work");
  expect(await Bun.file(join(f.cwd, "notes.txt")).text()).toBe("unrelated unstaged work\n");
  // The caller restores package.json on error; selecting the same version again
  // must be able to create the branch and commit normally.
  await Bun.write(join(f.cwd, "package.json"), await f.git("show", "HEAD:package.json"));
  await rm(hook);
  await Bun.write(join(f.cwd, "package.json"), '{"name":"test-cli","version":"1.1.0"}\n');
  expect(await prepareReleasePullRequest(run, "1.1.0", () => {})).toEndWith("/pull/1");
  expect(await f.git("rev-parse", "main")).toBe(f.initialSha);
  expect(await f.git("rev-parse", "origin/main")).toBe(f.initialSha);
  expect(await f.git("rev-parse", "origin/nimarc/release-v1.1.0")).toBe(await f.git("rev-parse", "HEAD"));
  expect(await f.git("diff", "HEAD^", "HEAD", "--name-only")).toBe("package.json");
  expect(await f.git("diff", "--cached", "--name-only")).toBe("notes.txt");
  expect(await f.git("ls-remote", "--tags", "origin")).toBe("");
  expect(await f.git("tag", "--list", "v1.1.0")).toBe("");
});

test("resumes after PR creation fails without another commit or tag push", async () => {
  const f = await fixture();
  await Bun.write(join(f.cwd, "package.json"), '{"name":"test-cli","version":"1.1.0"}\n');
  let fail = true;
  let existing: { url: string; state: string; headRefOid: string }[] = [];
  const run: ReleaseCommand = async (command, args, options) => {
    if (command === "git") return f.command(command, args, options);
    if (args[1] === "list") return { stdout: JSON.stringify(existing), stderr: "", exitCode: 0 };
    if (args[1] === "create") {
      if (fail) throw new Error("GitHub unavailable");
      existing = [{ url: "https://github.com/example/cli/pull/2", state: "OPEN", headRefOid: await f.git("rev-parse", "HEAD") }];
      return { stdout: existing[0]!.url, stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  let committed = false;
  await expect(prepareReleasePullRequest(run, "1.1.0", () => { committed = true; })).rejects.toThrow("GitHub unavailable");
  expect(committed).toBe(true);
  const releaseSha = await f.git("rev-parse", "HEAD");
  // Also exercises recovery when the old script left an unpublished local tag.
  await f.git("tag", "-a", "v1.1.0", "-m", "old local release tag");
  fail = false;
  expect(await resumeReleasePullRequest(run, "1.1.0")).toEndWith("/pull/2");
  expect(await resumeReleasePullRequest(run, "1.1.0")).toEndWith("/pull/2");
  expect(await f.git("rev-parse", "HEAD")).toBe(releaseSha);
  expect(await f.git("rev-list", "--count", "main..HEAD")).toBe("1");
  expect(await f.git("ls-remote", "--tags", "origin")).toBe("");
  await Bun.write(join(f.cwd, "package.json"), '{"name":"changed-name","version":"1.1.0"}\n');
  await f.git("commit", "-am", "unrelated change");
  await expect(resumeReleasePullRequest(run, "1.1.0")).rejects.toThrow();
  expect(await f.git("rev-parse", "origin/nimarc/release-v1.1.0")).toBe(releaseSha);
});

function greenChecks(sha: string): ReleaseCheck[] {
  return REQUIRED_RELEASE_CHECKS.map((name, index) => ({
    id: index + 1, name, head_sha: sha, status: "completed", conclusion: "success", app: { id: 15368 },
  }));
}

test("CI requires both successful checks from GitHub Actions on the exact commit", () => {
  const sha = "a".repeat(40);
  expect(() => assertRequiredReleaseChecks(sha, greenChecks(sha))).not.toThrow();
  expect(() => assertRequiredReleaseChecks(sha, [])).toThrow("missing");
  expect(() => assertRequiredReleaseChecks(sha, greenChecks(sha).slice(0, 1))).toThrow("missing");
  for (const change of [
    { status: "in_progress", conclusion: null },
    { conclusion: "skipped" }, { conclusion: "neutral" }, { conclusion: "failure" },
    { conclusion: "cancelled" }, { head_sha: "b".repeat(40) }, { app: { id: 1 } },
  ]) {
    const checks = greenChecks(sha);
    checks[0] = { ...checks[0]!, ...change };
    expect(() => assertRequiredReleaseChecks(sha, checks)).toThrow("Required CI is not green");
  }
  // A previous successful run must not mask a newer failed rerun.
  expect(() => assertRequiredReleaseChecks(sha, [
    ...greenChecks(sha), { ...greenChecks(sha)[0]!, id: 10, conclusion: "failure" },
  ])).toThrow("failure");
});

test("finalizes the squash-merged commit, reuses its draft, and rejects conflicting release state", async () => {
  const f = await fixture();
  await f.git("switch", "-c", "nimarc/release-v1.1.0");
  await Bun.write(join(f.cwd, "package.json"), '{"name":"test-cli","version":"1.1.0"}\n');
  await f.git("commit", "-am", "chore(release): v1.1.0");
  const branchSha = await f.git("rev-parse", "HEAD");
  await f.git("switch", "main");
  await f.git("merge", "--squash", "nimarc/release-v1.1.0");
  await f.git("commit", "-m", "chore(release): v1.1.0 (#1)");
  const mergedSha = await f.git("rev-parse", "HEAD");
  expect(mergedSha).not.toBe(branchSha);
  // Simulate the server merging the PR despite direct pushes being prohibited.
  await f.git("--git-dir", f.remote, "fetch", "--no-tags", f.cwd, "main:refs/heads/main");
  let checks = greenChecks(mergedSha);
  let releases: { tag_name: string; draft: boolean; prerelease: boolean; target_commitish: string; html_url: string }[] = [];
  let creations = 0;
  const run: ReleaseCommand = async (command, args, options) => {
    if (command === "git") return f.command(command, args, options);
    if (args[0] === "api" && args.some((arg) => arg.includes("/check-runs?"))) {
      // Pagination, plus a pending publication check, must not hide either CI gate.
      return { stdout: JSON.stringify([
        { check_runs: checks.slice(0, 1) },
        { check_runs: [...checks.slice(1), { ...greenChecks(mergedSha)[0], name: "Stage packages on npm", status: "waiting", conclusion: null }] },
      ]), stderr: "", exitCode: 0 };
    }
    if (args[0] === "api" && args.some((arg) => arg.includes("/releases?"))) {
      return { stdout: JSON.stringify([releases]), stderr: "", exitCode: 0 };
    }
    if (args[0] === "release" && args[1] === "create") {
      expect(args[args.indexOf("--target") + 1]).toBe(mergedSha);
      expect(args).toContain("--draft");
      expect(args).not.toContain("--prerelease");
      creations++;
      releases = [{ tag_name: "v1.1.0", draft: true, prerelease: false, target_commitish: mergedSha, html_url: "https://github.com/example/cli/releases/tag/draft" }];
      return { stdout: releases[0]!.html_url, stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  await expect(createDraftRelease(run, "1.2.0", mergedSha)).rejects.toThrow("contains version 1.1.0");
  checks = [];
  await expect(createDraftRelease(run, "1.1.0", mergedSha)).rejects.toThrow("missing");
  expect(creations).toBe(0);
  checks = greenChecks(mergedSha);
  expect(await createDraftRelease(run, "1.1.0", mergedSha, true)).toContain("Would create draft");
  expect(creations).toBe(0);
  const url = await createDraftRelease(run, "1.1.0", mergedSha);
  expect(await createDraftRelease(run, "1.1.0", mergedSha)).toBe(url);
  expect(creations).toBe(1);
  expect(await f.git("ls-remote", "--tags", "origin")).toBe("");
  releases[0]!.target_commitish = branchSha;
  await expect(createDraftRelease(run, "1.1.0", mergedSha)).rejects.toThrow("Existing draft does not match");
  releases[0]!.target_commitish = mergedSha;
  releases[0]!.draft = false;
  await expect(createDraftRelease(run, "1.1.0", mergedSha)).rejects.toThrow("already published");
  releases = [];
  await f.git("--git-dir", f.remote, "update-ref", "refs/tags/v1.1.0", f.initialSha);
  await expect(createDraftRelease(run, "1.1.0", mergedSha)).rejects.toThrow("refusing to move it");
  expect(creations).toBe(1);
  expect(await f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.1.0")).toBe(f.initialSha);
});

test("sets the GitHub prerelease flag and stops when CI cannot be queried", async () => {
  const f = await fixture();
  await Bun.write(join(f.cwd, "package.json"), '{"name":"test-cli","version":"1.1.0-rc.0"}\n');
  await f.git("commit", "-am", "prerelease");
  const sha = await f.git("rev-parse", "HEAD");
  let ciUnavailable = true;
  let creations = 0;
  const run: ReleaseCommand = async (command, args, options) => {
    if (command === "git") return f.command(command, args, options);
    if (args.some((arg) => arg.includes("/check-runs?"))) {
      if (ciUnavailable) throw new Error("CI API unavailable");
      return { stdout: JSON.stringify([{ check_runs: greenChecks(sha) }]), stderr: "", exitCode: 0 };
    }
    if (args.some((arg) => arg.includes("/releases?"))) return { stdout: "[[]]", stderr: "", exitCode: 0 };
    if (args[0] === "release" && args[1] === "create") {
      expect(args).toContain("--prerelease");
      creations++;
      return { stdout: "https://github.com/example/cli/releases/tag/draft", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  await expect(createDraftRelease(run, "1.1.0-rc.0", sha)).rejects.toThrow("CI API unavailable");
  expect(creations).toBe(0);
  ciUnavailable = false;
  await createDraftRelease(run, "1.1.0-rc.0", sha);
  expect(creations).toBe(1);
});

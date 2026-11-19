import { createInterface } from "node:readline/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gte, prerelease, valid } from "semver";

import {
  PRERELEASE_IDENTIFIERS,
  assertReleasableVersion,
  npmEnvironment,
  parseReleaseArgs,
  prereleaseVersion,
  publishTagForVersion,
  versionMenu,
  type PrereleaseIdentifier,
  type ReleaseOptions,
} from "./release-config";
import {
  CANONICAL_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
  prepareNpmPackages,
} from "./npm-packages";
import { npmReleasePlan, type NpmRegistryPackageState } from "./npm-release-plan";
import {
  assertCiGreen,
  createDraftRelease,
  prepareReleasePullRequest,
  releaseBranch,
  resumeReleasePullRequest,
} from "./release-workflow";

type PackageJson = {
  name: string;
  version: string;
  [key: string]: unknown;
};

const packageJsonPath = `${import.meta.dir}/../package.json`;
const npmCache = `${process.env.TMPDIR ?? "/tmp"}/langfuse-cli-npm-cache`;
const exactReleaseFiles = new Set([
  ".npmrc",
  "LICENSE",
  "MAINTENANCE.md",
  "README.md",
  "bun.lock",
  "package.json",
  "tsconfig.json",
]);
const releasePathPrefixes = [
  ".github/",
  "bin/",
  "conformance/",
  "npm/",
  "scripts/",
  "src/",
];
let releaseOptions: ReleaseOptions;
try {
  releaseOptions = parseReleaseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  printHelp();
  process.exit(1);
}
const isDryRun = releaseOptions.dryRun;
const allowDirty = releaseOptions.allowDirty;

let originalPackageJsonText: string | null = null;
let shouldRestorePackageJson = false;
let releaseCommitted = false;
let publishStarted = false;

function printHelp(): void {
  console.log(`Usage: bun run release -- [options]

Prepares a release: verifies main is clean, green, and in sync, runs all
gates, and opens a version-bump PR. After merging, pull main and rerun with
--finalize to create a draft from the merged commit after successful CI.
Publishing the GitHub release triggers npm staging via GitHub
Actions after approval of the npm-publish environment. Then approve both
${CANONICAL_PACKAGE_NAME} and ${LEGACY_PACKAGE_NAME} on npm with 2FA.

Options:
  --version <semver>  Release an explicit version without the version prompt
  --finalize          Create/reuse the draft for the current version on main
  --resume            Retry pushing/opening the current release branch's PR
  --dry-run           Check the plan without committing, pushing, or releasing
  --publish-local     ESCAPE HATCH: stage from this machine instead of Actions
                      (npm login required; approve separately on npm with 2FA)
  --tag <tag>         npm dist-tag for --publish-local; inferred from the
                      prerelease identifier otherwise
  --allow-dirty       Allow local changes with --dry-run for script testing
  -h, --help          Show this help`);
}

async function readPackageJson(): Promise<PackageJson> {
  originalPackageJsonText = await Bun.file(packageJsonPath).text();
  return JSON.parse(originalPackageJsonText) as PackageJson;
}

async function writePackageJson(pkg: PackageJson): Promise<void> {
  await Bun.write(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  shouldRestorePackageJson = true;
}

async function restorePackageJsonIfNeeded(): Promise<void> {
  if (
    !originalPackageJsonText ||
    !shouldRestorePackageJson ||
    releaseCommitted ||
    publishStarted
  ) {
    return;
  }

  await Bun.write(packageJsonPath, originalPackageJsonText);
  shouldRestorePackageJson = false;
  console.log("Restored package.json to its original version.");
}

function envForCommand(command: string): Record<string, string | undefined> {
  if (command !== "npm") return process.env;
  return npmEnvironment(process.env, npmCache);
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    capture?: boolean;
    suspendPrompt?: boolean;
    throwOnError?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!options.capture) console.log(`\n$ ${commandText(command, args)}`);

  if (options.suspendPrompt) rl.pause();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const proc = Bun.spawn([command, ...args], {
      env: envForCommand(command),
      stdin: "inherit",
      stdout: options.capture ? "pipe" : "inherit",
      stderr: options.capture ? "pipe" : "inherit",
    });
    const stdoutPromise =
      proc.stdout instanceof ReadableStream
        ? new Response(proc.stdout).text()
        : Promise.resolve("");
    const stderrPromise =
      proc.stderr instanceof ReadableStream
        ? new Response(proc.stderr).text()
        : Promise.resolve("");
    exitCode = await proc.exited;
    stdout = await stdoutPromise;
    stderr = await stderrPromise;
  } finally {
    if (options.suspendPrompt) rl.resume();
  }

  if (exitCode !== 0 && options.throwOnError !== false) {
    throw new Error(
      `${commandText(command, args)} failed with exit code ${exitCode}\n${stderr}`,
    );
  }

  return { stdout, stderr, exitCode };
}

function statusLinePaths(line: string): string[] {
  const rawPath = line.slice(3);
  return rawPath.includes(" -> ") ? rawPath.split(" -> ") : [rawPath];
}

function isReleaseRelevantPath(path: string): boolean {
  return (
    exactReleaseFiles.has(path) ||
    releasePathPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

async function assertNoReleaseRelevantChanges(ignorePackageJson = false): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  );
  const dirtyRelevantLines = stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .filter((line) => statusLinePaths(line).some((path) =>
      isReleaseRelevantPath(path) && !(ignorePackageJson && path === "package.json"),
    ));

  if (dirtyRelevantLines.length === 0) return;

  if (allowDirty) {
    console.log(
      "Release-relevant local changes present; continuing because --allow-dirty was set:",
    );
    console.log(dirtyRelevantLines.map((line) => `  ${line}`).join("\n"));
    return;
  }

  throw new Error(
    [
      "Release-relevant local changes are present. Commit or stash them before releasing.",
      "",
      ...dirtyRelevantLines.map((line) => `  ${line}`),
      "",
      "For local release-script testing only, rerun with --dry-run --allow-dirty.",
    ].join("\n"),
  );
}

async function assertOnMainAndSynced(): Promise<string> {
  const branch = (
    await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      capture: true,
    })
  ).stdout.trim();
  if (branch !== "main") {
    throw new Error(`Releases are cut from main; current branch is ${branch}.`);
  }
  await runCommand("git", ["fetch", "--no-tags", "origin", "main"], { capture: true });
  const head = (
    await runCommand("git", ["rev-parse", "HEAD"], { capture: true })
  ).stdout.trim();
  const originMain = (
    await runCommand("git", ["rev-parse", "origin/main"], { capture: true })
  ).stdout.trim();
  if (head !== originMain) {
    throw new Error(
      `Local main (${head.slice(0, 7)}) is not in sync with origin/main (${originMain.slice(0, 7)}). Use git pull --ff-only if behind. If ahead, move the local commits to a PR branch.`,
    );
  }
  return head;
}

async function assertTagAvailable(tagName: string): Promise<void> {
  const local = await runCommand(
    "git",
    ["rev-parse", "--quiet", "--verify", `refs/tags/${tagName}`],
    { capture: true, throwOnError: false },
  );
  if (local.exitCode === 0) {
    throw new Error(`Tag ${tagName} already exists locally.`);
  }
  const remote = await runCommand(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`],
    { capture: true },
  );
  if (remote.stdout.trim() !== "") {
    throw new Error(`Tag ${tagName} already exists on origin.`);
  }
}

async function assertVersionNotPublished(
  packageName: string,
  version: string,
): Promise<NpmRegistryPackageState> {
  console.log(`\nChecking npm for ${packageName}@${version}...`);
  const result = await runCommand(
    "npm",
    ["view", packageName, "versions", "dist-tags", "--json"],
    { capture: true, throwOnError: false },
  );
  if (result.exitCode !== 0) {
    if (result.stderr.includes("E404")) {
      return { name: packageName, currentDistTags: null, publishedGitHead: null };
    }
    throw new Error(
      `npm view ${packageName} versions dist-tags --json failed with exit code ${result.exitCode}\n${result.stderr}`,
    );
  }
  const metadata = JSON.parse(result.stdout) as {
    versions: string | string[];
    "dist-tags": Record<string, string>;
  };
  const versions = Array.isArray(metadata.versions) ? metadata.versions : [metadata.versions];

  if (versions.includes(version)) {
    throw new Error(`${packageName}@${version} already exists on npm.`);
  }
  return { name: packageName, currentDistTags: metadata["dist-tags"], publishedGitHead: null };
}

async function assertNpmPublishContext(): Promise<void> {
  const npmVersion = (await runCommand("npm", ["--version"], { capture: true })).stdout.trim();
  if (!valid(npmVersion) || !gte(npmVersion, "11.15.0")) {
    throw new Error(`npm ${npmVersion} is too old for staged publishing (need >= 11.15.0)`);
  }
  const registry = await runCommand("npm", ["config", "get", "registry"], {
    capture: true,
  });
  const registryUrl = registry.stdout.trim();

  if (registryUrl !== "https://registry.npmjs.org/") {
    throw new Error(
      `npm registry is ${registryUrl}; expected https://registry.npmjs.org/`,
    );
  }

  let whoami = await runCommand("npm", ["whoami"], {
    capture: true,
    throwOnError: false,
  });

  if (whoami.exitCode !== 0) {
    console.error(whoami.stderr.trim());
    const shouldLogin = await confirm(
      rl,
      "npm is not authenticated. Run npm login now?",
    );
    if (!shouldLogin) {
      throw new Error("npm login required before release.");
    }

    await runCommand(
      "npm",
      ["login", "--registry=https://registry.npmjs.org/", "--auth-type=web"],
      { suspendPrompt: true },
    );
    whoami = await runCommand("npm", ["whoami"], { capture: true });
  }

  const username = whoami.stdout.trim();
  if (!username) throw new Error("npm whoami did not return a username.");

  console.log(`npm auth: ${username}`);
  console.log(`npm registry: ${registryUrl}`);
}

async function printPostBuildReview(): Promise<void> {
  const [status, diffStat] = await Promise.all([
    runCommand("git", ["status", "--short"], { capture: true }),
    runCommand(
      "git",
      [
        "diff",
        "--stat",
        "--",
        "LICENSE",
        "README.md",
        "bin",
        "conformance",
        "npm",
        "package.json",
        "scripts",
        "src",
      ],
      { capture: true },
    ),
  ]);

  console.log("\nPost-build release review");
  console.log("git status --short:");
  console.log(status.stdout.trim() || "  clean");
  console.log("\ngit diff --stat:");
  console.log(diffStat.stdout.trim() || "  no tracked diff");
}

async function selectPrereleaseIdentifier(
  rl: ReturnType<typeof createInterface>,
): Promise<PrereleaseIdentifier | null> {
  console.log("Prerelease identifier:");
  PRERELEASE_IDENTIFIERS.forEach((identifier, index) => {
    console.log(`${index + 1}) ${identifier}`);
  });
  while (true) {
    const choice = (await rl.question("Identifier [3=rc]: ")).trim().toLowerCase();
    if (choice === "q" || choice === "quit" || choice === "cancel") return null;
    if (choice === "") return "rc";
    const byIndex = PRERELEASE_IDENTIFIERS[Number(choice) - 1];
    if (byIndex) return byIndex;
    if ((PRERELEASE_IDENTIFIERS as readonly string[]).includes(choice)) {
      return choice as PrereleaseIdentifier;
    }
    console.error(`Choose one of: ${PRERELEASE_IDENTIFIERS.join(", ")}`);
  }
}

async function selectVersion(
  rl: ReturnType<typeof createInterface>,
  currentVersion: string,
): Promise<string | null> {
  const options = versionMenu(currentVersion);

  console.log(`Current version: ${currentVersion}`);
  options.forEach((option, index) => {
    console.log(`${index + 1}) ${option.label}`);
  });
  const customIndex = options.length + 1;
  console.log(`${customIndex}) custom`);

  while (true) {
    const choice = (await rl.question("Select version [1]: ")).trim().toLowerCase();

    if (choice === "q" || choice === "quit" || choice === "cancel") return null;

    const index = choice === "" ? 0 : Number(choice) - 1;
    const option = Number.isInteger(index) ? options[index] : undefined;
    if (option) {
      if (option.version) return option.version;
      const identifier = await selectPrereleaseIdentifier(rl);
      if (identifier === null) return null;
      return prereleaseVersion(currentVersion, option.preLevel!, identifier);
    }

    if (Number(choice) === customIndex || choice === "custom" || choice === "c") {
      const custom = (await rl.question("Version: ")).trim();
      if (!valid(custom)) {
        console.error(`Invalid semver: ${custom}`);
        continue;
      }
      if (custom === currentVersion) {
        console.error("Version must change.");
        continue;
      }
      return custom;
    }

    console.error(`Choose 1-${customIndex}, or q to cancel.`);
  }
}

async function confirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

if (releaseOptions.showHelp) {
  printHelp();
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error("Release must be run from an interactive terminal.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

process.on("SIGINT", () => {
  restorePackageJsonIfNeeded()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    })
    .finally(() => {
      rl.close();
      process.exit(130);
    });
});

async function runGates(): Promise<void> {
  await runCommand("bun", ["run", "typecheck"]);
  await runCommand("bun", ["test"]);
  await runCommand("bun", ["run", "conformance:all"]);
}

// Default mode prepares a PR. Finalization happens only after its merge.
async function prepareRelease(): Promise<void> {
  if (!isDryRun) {
    await assertCiGreen(runCommand, await assertOnMainAndSynced());
    await runCommand("gh", ["auth", "status"], { capture: true });
    console.log("gh auth: ok");
  } else {
    console.log("Dry run: skipping branch/sync/CI/gh checks.");
  }
  await assertNoReleaseRelevantChanges();

  const pkg = await readPackageJson();
  const selectedVersion =
    releaseOptions.version ?? (await selectVersion(rl, pkg.version));
  if (!selectedVersion) {
    console.log("Release cancelled.");
    return;
  }
  // Check the same policy as CI before creating a release. CI rechecks it
  // because registry state can change after the cut.
  const nextVersion = assertReleasableVersion(selectedVersion);
  if (nextVersion === pkg.version) throw new Error("Version must change.");

  const distTag = publishTagForVersion(nextVersion);
  const isPrerelease = prerelease(nextVersion) !== null;
  const tagName = `v${nextVersion}`;
  console.log(`Release version: ${nextVersion}`);
  console.log(`Git tag: ${tagName}`);
  console.log(`npm dist-tag (applied after npm approval): ${distTag}`);

  const [canonical, legacy] = await Promise.all([
    assertVersionNotPublished(CANONICAL_PACKAGE_NAME, nextVersion),
    assertVersionNotPublished(LEGACY_PACKAGE_NAME, nextVersion),
  ]);
  npmReleasePlan({
    version: nextVersion,
    tagName,
    isPrerelease,
    releaseSha: (await runCommand("git", ["rev-parse", "HEAD"], { capture: true })).stdout.trim(),
    packages: { canonical, legacy },
  });
  if (!isDryRun) await assertTagAvailable(tagName);

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runGates();
  await assertNoReleaseRelevantChanges(true);

  if (isDryRun) {
    console.log(`\nDry run complete. Would have:`);
    console.log(`  - committed "chore(release): ${tagName}" on ${releaseBranch(nextVersion)}`);
    console.log("  - pushed that branch and opened a PR into main");
    console.log(`  - after merge: bun run release -- --finalize --version ${nextVersion}`);
    await restorePackageJsonIfNeeded();
    return;
  }

  const proceed = await confirm(
    rl,
    `Commit the version bump on ${releaseBranch(nextVersion)}, push it, and open a PR?`,
  );
  if (!proceed) {
    console.log("Release cancelled.");
    await restorePackageJsonIfNeeded();
    return;
  }

  const url = await prepareReleasePullRequest(runCommand, nextVersion, () => { releaseCommitted = true; });
  printPullRequestNextSteps(url, nextVersion);
}

function printPullRequestNextSteps(url: string, version: string): void {
  console.log(`\nRelease PR: ${url}`);
  console.log("After merging the PR and waiting for main CI:");
  console.log("  git switch main");
  console.log("  git pull --ff-only");
  console.log(`  bun run release -- --finalize --version ${version}`);
}

async function resumeRelease(): Promise<void> {
  await assertNoReleaseRelevantChanges();
  const pkg = await readPackageJson();
  const version = assertReleasableVersion(releaseOptions.version ?? pkg.version);
  if (version !== pkg.version) throw new Error(`Current package.json version is ${pkg.version}, not ${version}.`);
  await runCommand("gh", ["auth", "status"], { capture: true });
  if (!await confirm(rl, `Retry pushing ${releaseBranch(version)} and opening its release PR?`)) return;
  printPullRequestNextSteps(await resumeReleasePullRequest(runCommand, version), version);
}

async function finalizeRelease(): Promise<void> {
  await assertNoReleaseRelevantChanges();
  const sha = await assertOnMainAndSynced();
  await runCommand("gh", ["auth", "status"], { capture: true });
  const pkg = await readPackageJson();
  const version = assertReleasableVersion(releaseOptions.version ?? pkg.version);
  if (version !== pkg.version) {
    throw new Error(`Main contains ${pkg.version}, not ${version}. Merge the version-bump PR and pull main first.`);
  }
  // Check CI, tag binding and existing drafts before offering any mutation.
  const preview = await createDraftRelease(runCommand, version, sha, true);
  const [canonical, legacy] = await Promise.all([
    assertVersionNotPublished(CANONICAL_PACKAGE_NAME, version),
    assertVersionNotPublished(LEGACY_PACKAGE_NAME, version),
  ]);
  const distTag = publishTagForVersion(version);
  npmReleasePlan({
    version,
    tagName: `v${version}`,
    isPrerelease: prerelease(version) !== null,
    releaseSha: sha,
    packages: { canonical, legacy },
  });
  if (isDryRun) {
    console.log(`Dry run: ${preview}`);
    return;
  }
  if (!await confirm(rl, `Create/reuse draft v${version} from main commit ${sha.slice(0, 7)}?`)) return;
  const url = await createDraftRelease(runCommand, version, sha);
  console.log(`\nDraft release: ${url}`);
  console.log("Next steps:");
  console.log("  1. Edit the release notes on GitHub.");
  console.log("  2. Publish the release, open its Actions run, and approve npm-publish under Review deployments.");
  console.log("  3. Wait for staging to succeed; only then will the packages appear on npm's Staged Packages page.");
  console.log(`  4. Review and approve both npm packages with 2FA (version ${version}, dist-tag "${distTag}").`);
}

// Escape hatch: stage to npm from this machine, bypassing GitHub Actions.
// Requires npm login; npm approval with 2FA happens separately.
async function publishLocal(): Promise<void> {
  console.log(
    "publish-local: bypassing GitHub Actions. Prefer `bun run release` + publishing the GitHub release unless Actions is unavailable.",
  );
  await assertNoReleaseRelevantChanges();

  const pkg = await readPackageJson();
  const selectedVersion =
    releaseOptions.version ?? (await selectVersion(rl, pkg.version));

  if (!selectedVersion) {
    console.log("Release cancelled.");
    return;
  }
  const nextVersion = valid(selectedVersion);
  if (!nextVersion) throw new Error(`Invalid semver: ${selectedVersion}`);
  if (nextVersion === pkg.version) throw new Error("Version must change.");
  const publishTag = publishTagForVersion(nextVersion, releaseOptions.tag);
  console.log(`Release version: ${nextVersion}`);
  console.log(`npm dist-tag: ${publishTag}`);

  await assertVersionNotPublished(CANONICAL_PACKAGE_NAME, nextVersion);
  await assertVersionNotPublished(LEGACY_PACKAGE_NAME, nextVersion);
  await assertNpmPublishContext();

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runGates();

  const stagingParent = await mkdtemp(resolve(tmpdir(), "langfuse-cli-release-"));
  const releaseSha = (
    await runCommand("git", ["rev-parse", "HEAD"], { capture: true })
  ).stdout.trim();
  const packages = await prepareNpmPackages(
    resolve(stagingParent, "packages"),
    undefined,
    releaseSha,
  );

  try {
    await runCommand("npm", ["pack", "--dry-run", packages.canonical]);
    await runCommand("npm", ["pack", "--dry-run", packages.legacy]);
    await printPostBuildReview();

    if (isDryRun) {
      console.log("\nDry run complete. Staging skipped.");
      await restorePackageJsonIfNeeded();
      return;
    }

    const shouldPublish = await confirm(
      rl,
      `Stage ${CANONICAL_PACKAGE_NAME}@${nextVersion} and ${LEGACY_PACKAGE_NAME}@${nextVersion} to npm with dist-tag "${publishTag}" and the status above?`,
    );
    if (!shouldPublish) {
      console.log("Staging skipped.");
      await restorePackageJsonIfNeeded();
      return;
    }

    // conformance:all already built above, and npm pack --dry-run showed both
    // package contents. Avoid lifecycle runs producing different artifacts.
    publishStarted = true;
    await runCommand(
      "npm",
      ["stage", "publish", packages.canonical, "--ignore-scripts", "--tag", publishTag],
      { suspendPrompt: true },
    );
    await runCommand(
      "npm",
      ["stage", "publish", packages.legacy, "--ignore-scripts", "--tag", publishTag],
      { suspendPrompt: true },
    );
    console.log(
      `Staged both packages at ${nextVersion} with dist-tag "${publishTag}". Review and approve them on npm with 2FA.`,
    );
    console.log(
      `Create a release commit/tag for ${CANONICAL_PACKAGE_NAME}@${nextVersion}; publish-local does not commit automatically.`,
    );
  } finally {
    await rm(stagingParent, { force: true, recursive: true });
  }
}

try {
  if (releaseOptions.publishLocal) {
    await publishLocal();
  } else if (releaseOptions.finalize) {
    await finalizeRelease();
  } else if (releaseOptions.resume) {
    await resumeRelease();
  } else {
    await prepareRelease();
  }
} catch (error) {
  if (publishStarted) {
    console.error(
      "Staging failed after an upload may have started. Inspect npm Staged Packages before retrying; package.json was not rolled back.",
    );
  } else if (releaseCommitted) {
    console.error(
      "The version commit is on the release branch. Retry with bun run release -- --resume. No release tag was created.",
    );
  } else {
    await restorePackageJsonIfNeeded();
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}

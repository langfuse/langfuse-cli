import { createInterface } from "node:readline/promises";
import { prerelease, valid } from "semver";

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
]);
const releasePathPrefixes = ["bin/", "conformance/", "scripts/", "src/"];
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

Cuts a release: verifies main is clean, green, and in sync, runs all gates,
bumps the version, pushes a release commit + tag, and opens a draft GitHub
release. Publishing the GitHub release triggers the npm publish via GitHub
Actions (.github/workflows/release.yml, npm trusted publishing).

Options:
  --version <semver>  Release an explicit version without the version prompt
  --dry-run           Run all checks and show the plan without pushing anything
  --publish-local     ESCAPE HATCH: publish to npm from this machine instead of
                      GitHub Actions (interactive npm auth + OTP required)
  --tag <tag>         npm dist-tag for --publish-local; inferred from the
                      prerelease identifier otherwise
  --allow-dirty       Allow release-relevant local changes for script testing
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

async function assertNoReleaseRelevantChanges(): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  );
  const dirtyRelevantLines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((line) => statusLinePaths(line).some(isReleaseRelevantPath));

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
      "For local release-script testing only, rerun with --allow-dirty.",
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
  await runCommand("git", ["fetch", "origin", "main"], { capture: true });
  const head = (
    await runCommand("git", ["rev-parse", "HEAD"], { capture: true })
  ).stdout.trim();
  const originMain = (
    await runCommand("git", ["rev-parse", "origin/main"], { capture: true })
  ).stdout.trim();
  if (head !== originMain) {
    throw new Error(
      `Local main (${head.slice(0, 7)}) is not in sync with origin/main (${originMain.slice(0, 7)}). Pull or push first.`,
    );
  }
  return head;
}

async function warnUnlessCiGreen(sha: string): Promise<void> {
  const result = await runCommand(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/commits/${sha}/check-runs`,
      "--jq",
      '[.check_runs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")] | length',
    ],
    { capture: true, throwOnError: false },
  );
  const failing = Number(result.stdout.trim());
  if (result.exitCode === 0 && failing === 0) {
    console.log(`CI checks on ${sha.slice(0, 7)}: green`);
    return;
  }
  const reason =
    result.exitCode !== 0
      ? "could not query CI status via gh"
      : `${failing} check(s) on HEAD are not successful`;
  const proceed = await confirm(rl, `Warning: ${reason}. Continue anyway?`);
  if (!proceed) throw new Error("Release cancelled: CI not verified green.");
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
): Promise<void> {
  console.log(`\nChecking npm for ${packageName}@${version}...`);
  const { stdout } = await runCommand(
    "npm",
    ["view", packageName, "versions", "--json"],
    { capture: true },
  );
  const parsed = JSON.parse(stdout) as string | string[];
  const versions = Array.isArray(parsed) ? parsed : [parsed];

  if (versions.includes(version)) {
    throw new Error(`${packageName}@${version} already exists on npm.`);
  }
}

async function assertNpmPublishContext(): Promise<void> {
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

// Default mode: cut a release. Pushes a release commit + tag and opens a
// draft GitHub release; publishing that release triggers the npm publish in
// GitHub Actions via npm trusted publishing. Never touches npm itself.
async function cutRelease(): Promise<void> {
  if (!isDryRun) {
    await assertOnMainAndSynced().then(warnUnlessCiGreen);
    // `gh` is a hard post-push dependency (draft release creation); verify
    // auth before anything irreversible happens.
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
  // Enforce the same policy the publish workflow enforces, so nothing this
  // script cuts can be rejected by CI after the tag is pushed.
  const nextVersion = assertReleasableVersion(selectedVersion);
  if (nextVersion === pkg.version) throw new Error("Version must change.");

  const distTag = publishTagForVersion(nextVersion);
  const isPrerelease = prerelease(nextVersion) !== null;
  const tagName = `v${nextVersion}`;
  console.log(`Release version: ${nextVersion}`);
  console.log(`Git tag: ${tagName}`);
  console.log(`npm dist-tag (applied by CI): ${distTag}`);

  await assertVersionNotPublished(pkg.name, nextVersion);
  if (!isDryRun) await assertTagAvailable(tagName);

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runGates();

  if (isDryRun) {
    console.log(`\nDry run complete. Would have:`);
    console.log(`  - committed "chore(release): ${tagName}"`);
    console.log(`  - pushed main and tag ${tagName}`);
    console.log(
      `  - created a draft GitHub release${isPrerelease ? " (pre-release)" : ""}`,
    );
    await restorePackageJsonIfNeeded();
    return;
  }

  const proceed = await confirm(
    rl,
    `Push release commit + tag ${tagName} and open a draft GitHub release?`,
  );
  if (!proceed) {
    console.log("Release cancelled.");
    await restorePackageJsonIfNeeded();
    return;
  }

  await runCommand("git", ["add", "package.json"]);
  await runCommand("git", ["commit", "-m", `chore(release): ${tagName}`]);
  releaseCommitted = true;
  await runCommand("git", ["tag", "-a", tagName, "-m", tagName]);
  await runCommand("git", ["push", "origin", "main"]);
  await runCommand("git", ["push", "origin", `refs/tags/${tagName}`]);

  const releaseArgs = [
    "release",
    "create",
    tagName,
    "--draft",
    "--generate-notes",
    "--title",
    tagName,
    "--verify-tag",
  ];
  if (isPrerelease) releaseArgs.push("--prerelease");
  const created = await runCommand("gh", releaseArgs, { capture: true });
  const releaseUrl = created.stdout.trim();

  console.log(`\nDraft release created: ${releaseUrl}`);
  console.log("Next steps:");
  console.log("  1. Edit the release notes on GitHub.");
  console.log(
    `  2. Publish the release — GitHub Actions then publishes ${pkg.name}@${nextVersion} to npm with dist-tag "${distTag}".`,
  );
}

// Escape hatch: publish to npm from this machine, bypassing GitHub Actions.
// Requires interactive npm auth (and OTP when tokens are disallowed).
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

  await assertVersionNotPublished(pkg.name, nextVersion);
  await assertNpmPublishContext();

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runGates();

  await runCommand("npm", ["pack", "--dry-run"]);
  await printPostBuildReview();

  if (isDryRun) {
    console.log("\nDry run complete. Publish skipped.");
    await restorePackageJsonIfNeeded();
    return;
  }

  const shouldPublish = await confirm(
    rl,
    `Publish ${pkg.name}@${nextVersion} to npm with dist-tag "${publishTag}" and the status above?`,
  );
  if (!shouldPublish) {
    console.log("Publish skipped.");
    await restorePackageJsonIfNeeded();
    return;
  }

  // conformance:all already built above, and npm pack --dry-run showed the package
  // contents. Avoid a second lifecycle run producing a different publish.
  publishStarted = true;
  await runCommand("npm", ["publish", "--ignore-scripts", "--tag", publishTag], {
    suspendPrompt: true,
  });
  console.log(
    `Published ${pkg.name}@${nextVersion} with npm dist-tag "${publishTag}".`,
  );
  console.log(
    `Create a release commit/tag for ${pkg.name}@${nextVersion}; publish-local does not commit automatically.`,
  );
}

try {
  if (releaseOptions.publishLocal) {
    await publishLocal();
  } else {
    await cutRelease();
  }
} catch (error) {
  if (publishStarted) {
    console.error(
      "Publish command failed after npm publish started. Verify npm state before retrying; package.json was not rolled back.",
    );
  } else if (releaseCommitted) {
    console.error(
      "Release commit/tag were created but a later step failed. Inspect git state; nothing was rolled back automatically.",
    );
  } else {
    await restorePackageJsonIfNeeded();
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}

import { createInterface } from "node:readline/promises";

type PackageJson = {
  name: string;
  version: string;
  [key: string]: unknown;
};

const packageJsonPath = `${import.meta.dir}/../package.json`;
const npmCache = `${process.env.TMPDIR ?? "/tmp"}/langfuse-cli-npm-cache`;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)((?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?)$/;
const exactReleaseFiles = new Set([
  ".npmrc",
  "LICENSE",
  "README.md",
  "bun.lock",
  "package.json",
]);
const releasePathPrefixes = ["bin/", "conformance/", "scripts/", "src/"];
const rawArgs = process.argv.slice(2);
const isDryRun = rawArgs.includes("--dry-run");
const allowDirty = rawArgs.includes("--allow-dirty");
const shouldShowHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
const unknownArgs = rawArgs.filter(
  (arg) => !["--dry-run", "--allow-dirty", "--help", "-h"].includes(arg),
);

let originalPackageJsonText: string | null = null;
let shouldRestorePackageJson = false;
let publishStarted = false;

function printHelp(): void {
  console.log(`Usage: bun run release -- [options]

Options:
  --dry-run       Run checks, build, version bump, and npm pack dry-run, then restore package.json and skip publish
  --allow-dirty   Allow release-relevant local changes; intended for testing the release script itself
  -h, --help      Show this help`);
}

function bumpVersion(
  version: string,
  bump: "patch" | "minor" | "major",
): string | null {
  const match = semverPattern.exec(version);
  if (!match) return null;

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (bump === "patch") patch++;
  if (bump === "minor") {
    minor++;
    patch = 0;
  }
  if (bump === "major") {
    major++;
    minor = 0;
    patch = 0;
  }

  return `${major}.${minor}.${patch}`;
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
  if (!originalPackageJsonText || !shouldRestorePackageJson || publishStarted) return;

  await Bun.write(packageJsonPath, originalPackageJsonText);
  shouldRestorePackageJson = false;
  console.log("Restored package.json to its original version.");
}

function envForCommand(command: string): Record<string, string | undefined> {
  if (command !== "npm") return process.env;

  return {
    ...process.env,
    npm_config_cache: npmCache,
  };
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
    console.log("Release-relevant local changes present; continuing because --allow-dirty was set:");
    console.log(dirtyRelevantLines.map((line) => `  ${line}`).join("\n"));
    return;
  }

  throw new Error(
    [
      "Release-relevant local changes are present. Commit or stash them before publishing.",
      "",
      ...dirtyRelevantLines.map((line) => `  ${line}`),
      "",
      "For local release-script testing only, rerun with --allow-dirty.",
    ].join("\n"),
  );
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

    await runCommand("npm", [
      "login",
      "--registry=https://registry.npmjs.org/",
      "--auth-type=web",
    ], { suspendPrompt: true });
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

async function selectVersion(
  rl: ReturnType<typeof createInterface>,
  currentVersion: string,
): Promise<string | null> {
  const patch = bumpVersion(currentVersion, "patch");
  const minor = bumpVersion(currentVersion, "minor");
  const major = bumpVersion(currentVersion, "major");

  if (!patch || !minor || !major) {
    throw new Error(`Current package version is not valid semver: ${currentVersion}`);
  }

  console.log(`Current version: ${currentVersion}`);
  console.log(`1) patch  ${patch}`);
  console.log(`2) minor  ${minor}`);
  console.log(`3) major  ${major}`);
  console.log("4) custom");

  const choices: Record<string, string | null> = {
    "": patch,
    "1": patch,
    p: patch,
    patch,
    "2": minor,
    minor,
    "3": major,
    major,
    q: null,
    quit: null,
    cancel: null,
  };

  while (true) {
    const choice = (await rl.question("Bump version [1]: ")).trim().toLowerCase();

    if (Object.hasOwn(choices, choice)) {
      return choices[choice];
    }

    if (choice === "4" || choice === "custom" || choice === "c") {
      const custom = (await rl.question("Version: ")).trim();
      if (!semverPattern.test(custom)) {
        console.error(`Invalid semver: ${custom}`);
        continue;
      }
      if (custom === currentVersion) {
        console.error("Version must change.");
        continue;
      }
      return custom;
    }

    console.error("Choose 1, 2, 3, 4, or q.");
  }
}

async function confirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

if (shouldShowHelp) {
  printHelp();
  process.exit(0);
}

if (unknownArgs.length > 0) {
  console.error(`Unknown release option(s): ${unknownArgs.join(", ")}`);
  printHelp();
  process.exit(1);
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

async function main(): Promise<void> {
  await assertNoReleaseRelevantChanges();

  const pkg = await readPackageJson();
  const nextVersion = await selectVersion(rl, pkg.version);

  if (!nextVersion) {
    console.log("Release cancelled.");
    return;
  }

  await assertVersionNotPublished(pkg.name, nextVersion);
  await assertNpmPublishContext();

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runCommand("bun", ["run", "typecheck"]);
  await runCommand("bun", ["test"]);
  await runCommand("bun", ["run", "conformance:all"]);

  await runCommand("npm", ["pack", "--dry-run"]);
  await printPostBuildReview();

  if (isDryRun) {
    console.log("\nDry run complete. Publish skipped.");
    await restorePackageJsonIfNeeded();
    return;
  }

  const shouldPublish = await confirm(
    rl,
    `Publish ${pkg.name}@${nextVersion} to npm with the status above?`,
  );
  if (!shouldPublish) {
    console.log("Publish skipped.");
    await restorePackageJsonIfNeeded();
    return;
  }

  // conformance:all already built above, and npm pack --dry-run showed the package
  // contents. Avoid a second lifecycle run producing a different publish.
  publishStarted = true;
  await runCommand("npm", ["publish", "--ignore-scripts"], {
    suspendPrompt: true,
  });
  console.log(`Published ${pkg.name}@${nextVersion}.`);
  console.log(
    `Create a release commit/tag for ${pkg.name}@${nextVersion}; this script does not commit automatically.`,
  );
}

try {
  await main();
} catch (error) {
  if (!publishStarted) {
    await restorePackageJsonIfNeeded();
  } else {
    console.error(
      "Publish command failed after npm publish started. Verify npm state before retrying; package.json was not rolled back.",
    );
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}

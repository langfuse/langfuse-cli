import { createInterface } from "node:readline/promises";

type PackageJson = {
  name: string;
  version: string;
  [key: string]: unknown;
};

type Version = {
  major: number;
  minor: number;
  patch: number;
  suffix: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
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
  "openapi.yml",
  "package.json",
]);
const releasePathPrefixes = ["bin/", "scripts/", "src/"];
const rawArgs = process.argv.slice(2);
const isDryRun = rawArgs.includes("--dry-run");
const allowDirty = rawArgs.includes("--allow-dirty");
const shouldShowHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
const unknownArgs = rawArgs.filter(
  (arg) => !["--dry-run", "--allow-dirty", "--help", "-h"].includes(arg),
);

let originalPackageJsonText: string | null = null;
let packageJsonChanged = false;
let publishStarted = false;
let published = false;
let restoredPackageJson = false;

function printHelp(): void {
  console.log(`Usage: bun run release -- [options]

Options:
  --dry-run       Run checks, build, version bump, and npm pack dry-run, then restore package.json and skip publish
  --allow-dirty   Allow release-relevant local changes; intended for testing the release script itself
  -h, --help      Show this help`);
}

function parseVersion(version: string): Version | null {
  const match = semverPattern.exec(version);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    suffix: match[4] ?? "",
  };
}

function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}${version.suffix}`;
}

function bumpVersion(current: Version, bump: "patch" | "minor" | "major"): string {
  if (bump === "patch") {
    return formatVersion({
      major: current.major,
      minor: current.minor,
      patch: current.patch + 1,
      suffix: "",
    });
  }

  if (bump === "minor") {
    return formatVersion({
      major: current.major,
      minor: current.minor + 1,
      patch: 0,
      suffix: "",
    });
  }

  return formatVersion({
    major: current.major + 1,
    minor: 0,
    patch: 0,
    suffix: "",
  });
}

async function readPackageJson(): Promise<PackageJson> {
  originalPackageJsonText = await Bun.file(packageJsonPath).text();
  return JSON.parse(originalPackageJsonText) as PackageJson;
}

async function writePackageJson(pkg: PackageJson): Promise<void> {
  await Bun.write(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  packageJsonChanged = true;
}

async function restorePackageJsonIfNeeded(): Promise<void> {
  if (
    !originalPackageJsonText ||
    !packageJsonChanged ||
    published ||
    publishStarted ||
    restoredPackageJson
  ) {
    return;
  }

  await Bun.write(packageJsonPath, originalPackageJsonText);
  restoredPackageJson = true;
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

async function runCommand(command: string, args: string[]): Promise<void> {
  console.log(`\n$ ${commandText(command, args)}`);

  const proc = Bun.spawn([command, ...args], {
    env: envForCommand(command),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`${commandText(command, args)} failed with exit code ${exitCode}`);
  }
}

async function runCommandCapture(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], {
    env: envForCommand(command),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = proc.stdout.text();
  const stderrPromise = proc.stderr.text();
  const exitCode = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    throw new Error(
      `${commandText(command, args)} failed with exit code ${exitCode}\n${stderr}`,
    );
  }

  return { stdout, stderr };
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
  const { stdout } = await runCommandCapture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
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
  const { stdout } = await runCommandCapture("npm", [
    "view",
    packageName,
    "versions",
    "--json",
  ]);
  const parsed = JSON.parse(stdout) as string | string[];
  const versions = Array.isArray(parsed) ? parsed : [parsed];

  if (versions.includes(version)) {
    throw new Error(`${packageName}@${version} already exists on npm.`);
  }
}

async function assertNpmPublishContext(): Promise<void> {
  const [whoami, registry] = await Promise.all([
    runCommandCapture("npm", ["whoami"]),
    runCommandCapture("npm", ["config", "get", "registry"]),
  ]);
  const username = whoami.stdout.trim();
  const registryUrl = registry.stdout.trim();

  if (!username) {
    throw new Error("npm whoami did not return a username.");
  }

  if (registryUrl !== "https://registry.npmjs.org/") {
    throw new Error(
      `npm registry is ${registryUrl}; expected https://registry.npmjs.org/`,
    );
  }

  console.log(`npm auth: ${username}`);
  console.log(`npm registry: ${registryUrl}`);
}

async function printPostBuildReview(): Promise<void> {
  const [status, diffStat] = await Promise.all([
    runCommandCapture("git", ["status", "--short"]),
    runCommandCapture("git", [
      "diff",
      "--stat",
      "--",
      "LICENSE",
      "README.md",
      "bin",
      "openapi.yml",
      "package.json",
      "scripts",
      "src",
    ]),
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
  const current = parseVersion(currentVersion);
  if (!current) {
    throw new Error(`Current package version is not valid semver: ${currentVersion}`);
  }

  const options = {
    patch: bumpVersion(current, "patch"),
    minor: bumpVersion(current, "minor"),
    major: bumpVersion(current, "major"),
  };

  console.log(`Current version: ${currentVersion}`);
  console.log(`1) patch  ${options.patch}`);
  console.log(`2) minor  ${options.minor}`);
  console.log(`3) major  ${options.major}`);
  console.log("4) custom");

  while (true) {
    const choice = (await rl.question("Bump version [1]: ")).trim().toLowerCase();

    if (choice === "" || choice === "1" || choice === "patch" || choice === "p") {
      return options.patch;
    }
    if (choice === "2" || choice === "minor") {
      return options.minor;
    }
    if (choice === "3" || choice === "major") {
      return options.major;
    }
    if (choice === "q" || choice === "quit" || choice === "cancel") {
      return null;
    }
    if (choice === "4" || choice === "custom" || choice === "c") {
      const custom = (await rl.question("Version: ")).trim();
      if (!parseVersion(custom)) {
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

  await runCommand("bun", ["test"]);
  await runCommand("bun", ["run", "prepublishOnly"]);

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

  // prepublishOnly already ran above, and npm pack --dry-run showed the package
  // contents. Avoid a second lifecycle run producing a different publish.
  publishStarted = true;
  await runCommand("npm", ["publish", "--ignore-scripts"]);
  published = true;
  console.log(`Published ${pkg.name}@${nextVersion}.`);
}

try {
  await main();
} catch (error) {
  if (!publishStarted) {
    await restorePackageJsonIfNeeded();
  } else if (!published) {
    console.error(
      "Publish command failed after npm publish started. Verify npm state before retrying; package.json was not rolled back.",
    );
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";

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

const packageJsonUrl = new URL("../package.json", import.meta.url);
const npmCache = join(tmpdir(), "langfuse-cli-npm-cache");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)((?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?)$/;

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
  return JSON.parse(await readFile(packageJsonUrl, "utf-8")) as PackageJson;
}

async function writePackageJson(pkg: PackageJson): Promise<void> {
  await writeFile(packageJsonUrl, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  console.log(`\n$ ${[command, ...args].join(" ")}`);

  const child = spawn(command, args, {
    env:
      command === "npm"
        ? { ...process.env, npm_config_cache: npmCache }
        : process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
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

if (!process.stdin.isTTY) {
  console.error("Release must be run from an interactive terminal.");
  process.exit(1);
}

const rl = createInterface({ input, output });

async function main(): Promise<void> {
  const pkg = await readPackageJson();
  const nextVersion = await selectVersion(rl, pkg.version);

  if (!nextVersion) {
    console.log("Release cancelled.");
    return;
  }

  pkg.version = nextVersion;
  await writePackageJson(pkg);
  console.log(`Updated package.json to ${pkg.name}@${nextVersion}`);

  await runCommand("bun", ["test"]);
  await runCommand("bun", ["run", "build"]);
  await runCommand("npm", ["pack", "--dry-run"]);

  const shouldPublish = await confirm(rl, `Publish ${pkg.name}@${nextVersion} to npm?`);
  if (!shouldPublish) {
    console.log("Publish skipped. Release artifacts are built locally.");
    return;
  }

  // The release script already ran tests, build, and pack dry-run. Avoid npm
  // rerunning prepublishOnly and producing a different package than the dry run.
  await runCommand("npm", ["publish", "--ignore-scripts"]);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rl.close();
}

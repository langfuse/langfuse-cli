import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CANONICAL_PACKAGE_NAME = "@langfuse/cli";
export const LEGACY_PACKAGE_NAME = "langfuse-cli";

export interface PreparedNpmPackages {
  canonical: string;
  legacy: string;
}

type PackageJson = {
  name: string;
  version: string;
  [key: string]: unknown;
};

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`npm package output already exists: ${path}`);
}

async function copyPackageFiles(
  sourceRoot: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(resolve(sourceRoot, "bin"), resolve(destination, "bin"), {
      recursive: true,
    }),
    cp(resolve(sourceRoot, "dist"), resolve(destination, "dist"), {
      recursive: true,
    }),
    cp(resolve(sourceRoot, "LICENSE"), resolve(destination, "LICENSE")),
  ]);
}

async function writePackage(
  sourceRoot: string,
  destination: string,
  pkg: PackageJson,
  readme: string,
): Promise<void> {
  await copyPackageFiles(sourceRoot, destination);
  await Promise.all([
    writeFile(
      resolve(destination, "package.json"),
      `${JSON.stringify(pkg, null, 2)}\n`,
    ),
    cp(resolve(sourceRoot, readme), resolve(destination, "README.md")),
  ]);
}

export async function prepareNpmPackages(
  outputRoot: string,
  sourceRoot = resolve(import.meta.dir, ".."),
  gitHead?: string,
): Promise<PreparedNpmPackages> {
  const resolvedOutput = resolve(outputRoot);
  const resolvedSource = resolve(sourceRoot);
  await assertDoesNotExist(resolvedOutput);

  const pkg = JSON.parse(
    await readFile(resolve(resolvedSource, "package.json"), "utf8"),
  ) as PackageJson;
  if (pkg.name !== CANONICAL_PACKAGE_NAME) {
    throw new Error(
      `package.json must use canonical name ${CANONICAL_PACKAGE_NAME}; found ${pkg.name}`,
    );
  }
  if (gitHead && !/^[0-9a-f]{40}$/.test(gitHead)) {
    throw new Error(
      `git head must be a full lowercase commit SHA; found ${gitHead}`,
    );
  }
  const publishPackage = gitHead ? { ...pkg, gitHead } : pkg;

  const paths = {
    canonical: resolve(resolvedOutput, "canonical"),
    legacy: resolve(resolvedOutput, "legacy"),
  };
  await mkdir(resolvedOutput, { recursive: true });
  await Promise.all([
    writePackage(resolvedSource, paths.canonical, publishPackage, "README.md"),
    writePackage(
      resolvedSource,
      paths.legacy,
      { ...publishPackage, name: LEGACY_PACKAGE_NAME },
      "npm/legacy/README.md",
    ),
  ]);
  return paths;
}

if (import.meta.main) {
  const [outputRoot, gitHead] = process.argv.slice(2);
  if (!outputRoot) {
    throw new Error("Usage: bun scripts/npm-packages.ts <output-directory>");
  }
  const paths = await prepareNpmPackages(outputRoot, undefined, gitHead);
  console.log(JSON.stringify(paths));
}

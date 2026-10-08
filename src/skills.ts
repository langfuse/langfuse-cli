import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CliError, EXIT_LOCAL, EXIT_RESPONSE } from "./errors";
import {
  fetchFileContents,
  fetchSkill,
  FILE_CONTENT_BATCH_SIZE,
  type SkillFile,
  type SkillsConfig,
} from "./skills/api";
import { parseSkillsOptions, type SkillAction } from "./skills/options";
import { matchesManifest } from "./skills/local";
import { readSkillsLock, writeSkillsLock, type LangfuseSkillsLock } from "./skills/lock";
import { resolveSkillTargets } from "./skills/targets";

export async function runSkillsCommand(
  config: SkillsConfig,
  args: string[],
  action: SkillAction = "install",
): Promise<void> {
  const options = parseSkillsOptions(args, action);
  const lock: LangfuseSkillsLock = options.noLockfile
    ? { lockVersion: 1, skills: {} }
    : await readSkillsLock();
  const targets = await resolveSkillTargets(config, options, lock, action);
  await validateDestinations(targets.map(({ destination }) => destination), lock, options.noLockfile);

  // Resolve every manifest and check destinations before changing any installation.
  const installations = [];
  for (const { name, destination, selector, request, previousVersion } of targets) {
    const exists = await pathExists(destination);
    const skill = await fetchSkill(config, name, request);
    validateFilePaths(skill.files, destination);
    const unchanged = exists && await matchesManifest(destination, skill.files);
    if (exists && !unchanged && !options.force) {
      // Updates may replace a clean recorded version, but must preserve local edits.
      let cleanUpdate = false;
      if (action === "update" && previousVersion !== undefined && previousVersion !== skill.version) {
        const previous = await fetchSkill(config, name, { version: previousVersion });
        cleanUpdate = await matchesManifest(destination, previous.files);
      }
      if (!cleanUpdate) {
        throw new CliError(
          `${destination} contains different files; pass --force to replace it`,
          EXIT_LOCAL,
        );
      }
    }
    installations.push({ skill, destination, selector, exists, unchanged });
  }

  const results = [];
  for (const { skill, destination, selector, exists, unchanged } of installations) {
    if (!unchanged) await installFiles(config, skill.files, destination, exists);
    if (!options.noLockfile) {
      const lockKey = relative(process.cwd(), destination).split(sep).join("/");
      lock.skills[lockKey] = { name: skill.name, selector, version: skill.version };
      await writeSkillsLock(lock);
    }
    results.push({
      name: skill.name,
      version: skill.version,
      labels: skill.labels,
      directory: destination,
      files: skill.files.length,
      status: unchanged ? "unchanged" : "installed",
    });
    if (!config.json) {
      process.stdout.write(unchanged
        ? `Already up to date: ${skill.name}@${skill.version} at ${destination}\n`
        : `Installed ${skill.name}@${skill.version} to ${destination} (${skill.files.length} files)\n`,
      );
    }
  }
  if (config.json) {
    const result = action === "install" && options.name !== undefined ? results[0] : results;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (targets.length === 0) {
    process.stdout.write(`No skills found with tag ${JSON.stringify(options.tag)}\n`);
  }
}

async function validateDestinations(targets: string[], lock: LangfuseSkillsLock, allowExternal: boolean): Promise<void> {
  if (targets.length === 0) return;
  const selected = new Set(targets);
  const directories = [...new Set(targets.concat(Object.keys(lock.skills).map((path) => resolve(path))))];
  const physicalPaths = await Promise.all(directories.map(resolvePhysicalPath));
  if (!allowExternal) {
    const root = await realpath(process.cwd());
    for (let i = 0; i < directories.length; i++) {
      if (selected.has(directories[i]) && (physicalPaths[i] === root || !containsDirectory(root, physicalPaths[i]))) {
        throw new CliError(`Locked skill installation must stay within the project: ${directories[i]}. Use an explicit --directory with --no-lockfile to install outside the project.`, EXIT_LOCAL);
      }
    }
  }
  for (let i = 0; i < directories.length; i++) {
    for (let j = i + 1; j < directories.length; j++) {
      if (!selected.has(directories[i]) && !selected.has(directories[j])) continue;
      if (containsDirectory(physicalPaths[i], physicalPaths[j]) || containsDirectory(physicalPaths[j], physicalPaths[i])) {
        throw new CliError(`Skill installation directories overlap: ${directories[i]} and ${directories[j]}`, EXIT_LOCAL);
      }
    }
  }
}

async function resolvePhysicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolve(await resolvePhysicalPath(dirname(path)), basename(path));
    }
    throw new CliError(`Cannot check installation directory ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT_LOCAL);
  }
}

function containsDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function validateFilePaths(files: SkillFile[], directory: string): void {
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new CliError("Langfuse skill manifest has no root SKILL.md", EXIT_RESPONSE);
  }
  const paths = new Set<string>();
  for (const file of files) {
    const destination = resolveFilePath(directory, file.path);
    if (paths.has(destination)) {
      throw new CliError(`Skill manifest contains duplicate path: ${file.path}`, EXIT_RESPONSE);
    }
    paths.add(destination);
  }
}

async function installFiles(
  config: SkillsConfig,
  files: SkillFile[],
  destination: string,
  replace: boolean,
): Promise<void> {
  const parent = dirname(destination);
  const staging = resolve(parent, `.${basename(destination)}.install-${randomUUID()}`);
  try {
    await mkdir(parent, { recursive: true });
    await mkdir(staging);
    await downloadFiles(config, files, staging);
    // Verify names as stored by the filesystem, including directory spelling.
    if (!await matchesManifest(staging, files)) {
      throw new CliError("Skill file paths conflict on this filesystem", EXIT_RESPONSE);
    }
    await replaceDirectory(staging, destination, replace);
  } catch (error) {
    throw error instanceof CliError
      ? error
      : new CliError(
          `Cannot install skill: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_LOCAL,
        );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function downloadFiles(
  config: SkillsConfig,
  files: SkillFile[],
  directory: string,
): Promise<void> {
  const filesByHash = new Map<string, SkillFile[]>();
  for (const file of files) {
    const matching = filesByHash.get(file.sha256Hash) ?? [];
    matching.push(file);
    filesByHash.set(file.sha256Hash, matching);
  }
  const hashes = [...filesByHash.keys()];
  for (let offset = 0; offset < hashes.length; offset += FILE_CONTENT_BATCH_SIZE) {
    const batch = hashes.slice(offset, offset + FILE_CONTENT_BATCH_SIZE);
    const contents = await fetchFileContents(config, batch);
    for (const hash of batch) {
      for (const file of filesByHash.get(hash)!) {
        await writeVerifiedFile(directory, file, contents.get(hash)!);
      }
    }
  }
}

async function writeVerifiedFile(
  directory: string,
  file: SkillFile,
  content: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength !== file.contentLength) {
    throw new CliError(
      `Downloaded size mismatch for ${file.path}: expected ${file.contentLength}, got ${bytes.byteLength}`,
      EXIT_RESPONSE,
    );
  }
  if (createHash("sha256").update(bytes).digest("base64") !== file.sha256Hash) {
    throw new CliError(`Downloaded checksum mismatch for ${file.path}`, EXIT_RESPONSE);
  }
  const destination = resolveFilePath(directory, file.path);
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new CliError(`Skill file path conflicts on this filesystem: ${file.path}`, EXIT_RESPONSE);
    }
    throw error;
  }
  await chmod(destination, 0o644);
}

async function replaceDirectory(
  staging: string,
  destination: string,
  replace: boolean,
): Promise<void> {
  const backup = resolve(dirname(destination), `.${basename(destination)}.backup-${randomUUID()}`);
  if (replace) await rename(destination, backup);
  try {
    await rename(staging, destination);
  } catch (error) {
    if (replace) await rename(backup, destination);
    throw error;
  }
  if (replace) await rm(backup, { recursive: true, force: true });
}

function resolveFilePath(directory: string, filePath: string): string {
  const segments = filePath.split("/");
  if (
    filePath.includes("\\") || filePath.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new CliError(`Skill contains unsafe file path: ${JSON.stringify(filePath)}`, EXIT_RESPONSE);
  }
  const destination = resolve(directory, filePath);
  const relativePath = relative(directory, destination);
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new CliError(`Skill contains unsafe file path: ${JSON.stringify(filePath)}`, EXIT_RESPONSE);
  }
  return destination;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

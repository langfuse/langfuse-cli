import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CliError, EXIT_LOCAL } from "../errors";
import type { LangfuseSkillsLock } from "./lock";

export async function validateSkillDirectories(targets: string[], lock: LangfuseSkillsLock, lockfile?: string): Promise<void> {
  if (targets.length === 0) return;
  const selected = new Set(targets);
  const lockDirectory = lockfile === undefined ? process.cwd() : dirname(lockfile);
  const directories = [...new Set(targets.concat(lock.skills.map((skill) => resolve(lockDirectory, skill.path))))];
  const physicalPaths = await Promise.all(directories.map(resolvePhysicalPath));
  if (lockfile !== undefined) {
    const root = await realpath(process.cwd());
    const lockPath = await resolvePhysicalPath(lockfile);
    for (let i = 0; i < directories.length; i++) {
      if (containsDirectory(physicalPaths[i], lockPath)) {
        throw new CliError(`Lockfile must be outside skill directories: ${lockfile}`, EXIT_LOCAL);
      }
      if (selected.has(directories[i]) && (physicalPaths[i] === root || !containsDirectory(root, physicalPaths[i]))) {
        throw new CliError(`Locked skill directory must stay within the project: ${directories[i]}. Use --no-lockfile to work with a directory outside the project.`, EXIT_LOCAL);
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

export async function resolvePhysicalPath(path: string): Promise<string> {
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

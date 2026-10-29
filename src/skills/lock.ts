import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";

import { CliError, EXIT_LOCAL } from "../errors";
import { skillNameSchema, skillSelectorSchema } from "./api";
import { resolvePhysicalPath } from "./directories";

const lockedSkillSchema = z.strictObject({
  // Installation directory relative to this lockfile and within the project.
  path: z.string().min(1),
  name: skillNameSchema,
  selector: skillSelectorSchema,
  version: z.number().int().positive(),
});

export const langfuseSkillsLockSchema = z.strictObject({
  lockVersion: z.literal(1),
  skills: z.array(lockedSkillSchema).refine(
    (skills) => new Set(skills.map((skill) => skill.path)).size === skills.length,
    { message: "Skill paths must be unique" },
  ),
});

export type LockedSkill = z.infer<typeof lockedSkillSchema>;
export type LangfuseSkillsLock = z.infer<typeof langfuseSkillsLockSchema>;

export async function resolveSkillsLockPath(directory: string, path?: string, noLockfile = false): Promise<string | undefined> {
  if (path !== undefined && noLockfile) throw new CliError("Use either --lockfile or --no-lockfile, not both");
  if (noLockfile) return undefined;
  if (path === "") throw new CliError("--lockfile requires a value");
  if (path !== undefined) return canonicalizeLockPath(resolve(path));
  const defaultPath = resolve(directory, "langfuse-skills.lock");
  for (const candidate of new Set([defaultPath, resolve("langfuse-skills.lock")])) {
    try {
      await lstat(candidate);
      return canonicalizeLockPath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliError(`Cannot check ${candidate}: ${formatLockError(error)}`, EXIT_LOCAL);
      }
    }
  }
  return canonicalizeLockPath(defaultPath);
}

async function canonicalizeLockPath(path: string): Promise<string> {
  return resolve(await resolvePhysicalPath(dirname(path)), basename(path));
}

export async function readSkillsLock(path: string): Promise<LangfuseSkillsLock> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return langfuseSkillsLockSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lockVersion: 1, skills: [] };
    }
    throw new CliError(
      `Cannot read ${path}: ${formatLockError(error)}`,
      EXIT_LOCAL,
    );
  }
}

export function recordLockedSkill(lock: LangfuseSkillsLock, path: string, skill: LockedSkill): void {
  const directory = dirname(path);
  const destination = resolve(directory, skill.path);
  lock.skills = lock.skills.filter((existing) => resolve(directory, existing.path) !== destination);
  lock.skills.push(skill);
}

export async function writeSkillsLock(lock: LangfuseSkillsLock, path: string): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const validated = langfuseSkillsLockSchema.parse(lock);
    const sorted: LangfuseSkillsLock = {
      ...validated,
      skills: [...validated.skills].sort((a, b) => a.path.localeCompare(b.path)),
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    throw new CliError(
      `Cannot write ${path}: ${formatLockError(error)}`,
      EXIT_LOCAL,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

function formatLockError(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  return error instanceof Error ? error.message : String(error);
}

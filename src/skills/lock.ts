import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { CliError, EXIT_LOCAL } from "../errors";
import { skillNameSchema, skillSelectorSchema } from "./api";

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

const LOCK_FILE = "langfuse-skills.lock.json";

export async function readSkillsLock(): Promise<LangfuseSkillsLock> {
  try {
    const value: unknown = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    return langfuseSkillsLockSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lockVersion: 1, skills: [] };
    }
    throw new CliError(
      `Cannot read ${LOCK_FILE}: ${formatLockError(error)}`,
      EXIT_LOCAL,
    );
  }
}

export function recordLockedSkill(lock: LangfuseSkillsLock, skill: LockedSkill): void {
  const destination = resolve(skill.path);
  lock.skills = lock.skills.filter((existing) => resolve(existing.path) !== destination);
  lock.skills.push(skill);
}

export async function writeSkillsLock(lock: LangfuseSkillsLock): Promise<void> {
  const temporary = `.${LOCK_FILE}.${randomUUID()}.tmp`;
  try {
    const validated = langfuseSkillsLockSchema.parse(lock);
    const sorted: LangfuseSkillsLock = {
      ...validated,
      skills: [...validated.skills].sort((a, b) => a.path.localeCompare(b.path)),
    };
    await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, LOCK_FILE);
  } catch (error) {
    throw new CliError(
      `Cannot write ${LOCK_FILE}: ${formatLockError(error)}`,
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

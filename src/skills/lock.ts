import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";

import { CliError, EXIT_LOCAL } from "../errors";
import { skillNameSchema, skillSelectorSchema } from "./api";

const lockedSkillSchema = z.strictObject({
  name: skillNameSchema,
  selector: skillSelectorSchema,
  version: z.number().int().positive(),
});

const langfuseSkillsLockV1Schema = z.strictObject({
  lockVersion: z.literal(1),
  // Installation directory relative to this lockfile and within the project.
  skills: z.record(z.string().min(1), lockedSkillSchema),
});

export const langfuseSkillsLockSchema = z.discriminatedUnion("lockVersion", [
  langfuseSkillsLockV1Schema,
]);

export type LangfuseSkillsLock = z.infer<typeof langfuseSkillsLockSchema>;

const LOCK_FILE = "langfuse-skills-lock.json";

export async function readSkillsLock(): Promise<LangfuseSkillsLock> {
  try {
    const value: unknown = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    return langfuseSkillsLockSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lockVersion: 1, skills: {} };
    }
    throw new CliError(
      `Cannot read ${LOCK_FILE}: ${formatLockError(error)}`,
      EXIT_LOCAL,
    );
  }
}

export async function writeSkillsLock(lock: LangfuseSkillsLock): Promise<void> {
  const temporary = `.${LOCK_FILE}.${randomUUID()}.tmp`;
  try {
    const validated = langfuseSkillsLockSchema.parse(lock);
    const sorted: LangfuseSkillsLock = {
      ...validated,
      skills: Object.fromEntries(Object.entries(validated.skills).sort(([a], [b]) => a.localeCompare(b))),
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

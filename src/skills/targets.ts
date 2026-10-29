import { dirname, isAbsolute, resolve } from "node:path";

import { CliError, EXIT_LOCAL } from "../errors";
import { fetchSkills, type SkillsConfig, type SkillSelector } from "./api";
import { resolvePhysicalPath } from "./directories";
import type { LangfuseSkillsLock } from "./lock";
import type { SkillsOptions, SkillAction } from "./options";

interface SkillTarget {
  name: string;
  destination: string;
  selector: SkillSelector;
  request: SkillSelector;
  previousVersion?: number;
}

interface SkippedSkill {
  name: string;
  status: "skipped";
  reason: "no-production-version";
}

export async function resolveSkillTargets(
  config: SkillsConfig,
  options: SkillsOptions,
  lock: LangfuseSkillsLock,
  action: SkillAction,
): Promise<{ targets: SkillTarget[]; skipped: SkippedSkill[] }> {
  if (action === "update" || (options.name === undefined && options.tag === undefined && !options.all)) {
    const lockfile = options.lockfile;
    if (lockfile === undefined) throw new CliError("Bare install and update require a lockfile");
    const entries = lock.skills
      .filter((skill) => options.name === undefined || skill.name === options.name);
    if (entries.length === 0) {
      throw new CliError(options.name
        ? `No installation of ${options.name} found in ${options.lockfile}`
        : `No skills recorded in ${options.lockfile}; install a skill by name, --tag, or --all first`,
      );
    }
    const destinations = new Set<string>();
    const targets = entries.map((skill) => {
      const { path } = skill;
      const destination = resolve(dirname(lockfile), path);
      if (isAbsolute(path) || destinations.has(destination)) {
        throw new CliError(`Invalid or duplicate installation directory in lockfile: ${path}`, EXIT_LOCAL);
      }
      destinations.add(destination);
      return {
        name: skill.name,
        destination,
        selector: skill.selector,
        request: action === "update" ? skill.selector : { version: skill.version },
        previousVersion: skill.version,
      };
    });
    return { targets, skipped: [] };
  }

  const selector: SkillSelector = options.version !== undefined
    ? { version: options.version }
    : { label: options.label ?? "production" };
  const names: string[] = [];
  const skipped: SkippedSkill[] = [];
  if (options.all || options.tag !== undefined) {
    for (const skill of await fetchSkills(config, options.tag)) {
      if (options.label === undefined && skill.productionVersion === null) {
        skipped.push({ name: skill.name, status: "skipped", reason: "no-production-version" });
      } else {
        names.push(skill.name);
      }
    }
  } else {
    names.push(options.name!);
  }
  const targets = await Promise.all(names.map(async (name) => ({
    name,
    destination: await resolvePhysicalPath(resolve(options.directory, name)),
    selector,
    request: selector,
  })));
  return { targets, skipped };
}

import { basename, resolve } from "node:path";

import { CliError, EXIT_LOCAL } from "../errors";
import { fetchSkillNamesByTag, type SkillsConfig, type SkillSelector } from "./api";
import type { LangfuseSkillsLock } from "./lock";
import type { SkillsOptions, SkillAction } from "./options";

interface SkillTarget {
  name: string;
  destination: string;
  selector: SkillSelector;
  request: SkillSelector;
  previousVersion?: number;
}

export async function resolveSkillTargets(
  config: SkillsConfig,
  options: SkillsOptions,
  lock: LangfuseSkillsLock,
  action: SkillAction,
): Promise<SkillTarget[]> {
  if (action === "update" || (options.name === undefined && options.tag === undefined)) {
    const entries = Object.entries(lock.skills)
      .filter(([, skill]) => options.name === undefined || skill.name === options.name);
    if (entries.length === 0) {
      throw new CliError(options.name
        ? `No installation of ${options.name} found in langfuse-skills-lock.json`
        : "No skills recorded in langfuse-skills-lock.json; install a skill by name or --tag first",
      );
    }
    const destinations = new Set<string>();
    return entries.map(([path, skill]) => {
      const destination = resolve(path);
      if (basename(destination) !== skill.name || destinations.has(destination)) {
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
  }

  const selector: SkillSelector = options.version !== undefined
    ? { version: options.version }
    : { label: options.label ?? "production" };
  const names = options.tag !== undefined
    ? await fetchSkillNamesByTag(config, options.tag)
    : [options.name!];
  return names.map((name) => ({
    name,
    destination: resolve(options.directory, name),
    selector,
    request: selector,
  }));
}

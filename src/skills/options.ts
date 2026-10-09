import { parseArgs } from "node:util";

import { CliError } from "../errors";
import { skillNameSchema } from "./api";

export type SkillAction = "install" | "update";

export interface SkillsOptions {
  name?: string;
  tag?: string;
  version?: number;
  label?: string;
  directory: string;
  force: boolean;
  noLockfile: boolean;
}

export function parseSkillsOptions(args: string[], action: SkillAction = "install"): SkillsOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        tag: { type: "string" },
        version: { type: "string" },
        label: { type: "string" },
        directory: { type: "string" },
        force: { type: "boolean", default: false },
        "no-lockfile": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const { positionals, values } = parsed;
  if (positionals.length > 1 || (values.tag !== undefined && positionals.length > 0)) {
    throw new CliError("Provide at most one skill name, or --tag <tag>");
  }
  let [name] = positionals;
  if (name?.includes("@")) {
    if (action === "update") {
      throw new CliError("skills update uses the saved selector; use skills install to select a label or version");
    }
    if (values.label !== undefined || values.version !== undefined) {
      throw new CliError("Use either name@selector or --label/--version, not both");
    }
    const separator = name.indexOf("@");
    const selector = name.slice(separator + 1);
    name = name.slice(0, separator);
    if (!selector) throw new CliError("Provide a label or version after @");
    if (/^[0-9]+$/.test(selector)) {
      values.version = selector;
    } else {
      values.label = selector;
    }
  }
  if (values["no-lockfile"] && (action === "update" || (name === undefined && values.tag === undefined))) {
    throw new CliError("--no-lockfile requires skills install with a name or --tag; bare install and update require the lockfile");
  }
  if (name !== undefined && !skillNameSchema.safeParse(name).success) {
    throw new CliError("Skill names may only contain lowercase letters, numbers, and single hyphens");
  }
  for (const option of ["tag", "version", "label", "directory"] as const) {
    if (values[option] === "") throw new CliError(`--${option} requires a value`);
    if (action === "update" && values[option] !== undefined) {
      throw new CliError(`skills update uses saved selectors and directories; --${option} is only supported by skills install`);
    }
  }
  if (name === undefined && values.tag === undefined) {
    for (const option of ["version", "label", "directory"] as const) {
      if (values[option] !== undefined) {
        throw new CliError(`--${option} requires a skill name or --tag; bare install uses the lockfile`);
      }
    }
  }
  const version = values.version === undefined ? undefined : Number(values.version);
  if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
    throw new CliError("Skill version must be a positive safe integer");
  }
  if (version !== undefined && values.label !== undefined) {
    throw new CliError("Use either --version or --label, not both");
  }
  if (version !== undefined && values.tag !== undefined) {
    throw new CliError("--version requires a skill name; use --label with --tag");
  }
  return {
    name,
    tag: values.tag,
    version,
    label: values.label,
    directory: values.directory ?? ".agents/skills",
    force: values.force,
    noLockfile: values["no-lockfile"],
  };
}

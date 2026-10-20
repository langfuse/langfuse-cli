import { parseArgs } from "node:util";

import { CliError } from "../errors";
import { skillNameSchema } from "./api";
import { resolveSkillsLockPath } from "./lock";

export type SkillAction = "install" | "update";

export interface SkillsOptions {
  name?: string;
  tag?: string;
  all: boolean;
  version?: number;
  label?: string;
  directory: string;
  lockfile?: string;
  force: boolean;
}

export async function parseSkillsOptions(args: string[], action: SkillAction = "install"): Promise<SkillsOptions> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        tag: { type: "string" },
        all: { type: "boolean", default: false },
        version: { type: "string" },
        label: { type: "string" },
        directory: { type: "string" },
        lockfile: { type: "string" },
        force: { type: "boolean", default: false },
        "no-lockfile": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const { positionals, values } = parsed;
  const selectors = Number(positionals.length > 0) + Number(values.tag !== undefined) + Number(values.all);
  if (positionals.length > 1 || selectors > 1) {
    throw new CliError("Use a skill name, --tag <tag>, or --all, not more than one");
  }
  if (action === "update" && values.all) {
    throw new CliError("--all is only supported by skills install; skills update uses the lockfile");
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
  if (values["no-lockfile"] && (action === "update" || selectors === 0)) {
    throw new CliError("--no-lockfile requires skills install with a name, --tag, or --all; bare install and update require the lockfile");
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
  if (selectors === 0) {
    for (const option of ["version", "label", "directory"] as const) {
      if (values[option] !== undefined) {
        throw new CliError(`--${option} requires a skill name, --tag, or --all; bare install uses the lockfile`);
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
  if (version !== undefined && name === undefined) {
    throw new CliError("--version requires a skill name; use --label with --tag or --all");
  }
  return {
    name,
    tag: values.tag,
    all: values.all,
    version,
    label: values.label,
    directory: values.directory ?? ".agents/skills",
    lockfile: await resolveSkillsLockPath(values.directory ?? ".agents/skills", values.lockfile, values["no-lockfile"]),
    force: values.force,
  };
}

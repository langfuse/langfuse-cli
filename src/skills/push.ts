import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { CliError, EXIT_LOCAL, EXIT_RESPONSE } from "../errors";
import { createSkillVersion, fetchLatestSkill, setSkillLabels, type SkillVersion, type SkillsConfig } from "./api";
import { discoverSkillDirectories, readLocalSkill, type LocalSkill, type LocalSkillFile } from "./local-skill";

import { validateSkillDirectories } from "./directories";
import { readSkillsLock, writeSkillsLock, recordLockedSkill, resolveSkillsLockPath, type LangfuseSkillsLock } from "./lock";

interface PushOptions {
  directory: string;
  commitMessage?: string;
  label?: string;
  dryRun: boolean;
  recursive: boolean;
  updateOnly: boolean;
  noLockfile: boolean;
  lockfile?: string;
}

interface SnapshotChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

interface PushPlan {
  local: LocalSkill;
  previous?: SkillVersion;
  changes: SnapshotChanges;
  unchanged: boolean;
}

interface SkippedLocalSkill {
  directory: string;
  status: "skipped";
  reason: "invalid-skill";
  message: string;
  dryRun?: true;
}

interface SkillResult {
  name: string;
  directory: string;
  files: number;
}

type CompletedPushResult = SkillResult & {
  version: number;
  status: "unchanged" | "created" | "labeled";
  labels: string[];
};

type ValidSkillResult = CompletedPushResult | SkillResult & { version: number | null } & (
  | { status: "skipped"; reason: "not-found"; dryRun?: true }
  | { status: "unchanged" | "would-create" | "would-label"; changes: SnapshotChanges; dryRun: true; label?: string }
);

type PushResult = SkippedLocalSkill | ValidSkillResult;

function parsePushOptions(args: string[]): PushOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "commit-message": { type: "string" },
        label: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        recursive: { type: "boolean", default: false },
        "update-only": { type: "boolean", default: false },
        "no-lockfile": { type: "boolean", default: false },
        lockfile: { type: "string" },
      },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
    throw new CliError("skills push requires one directory");
  }
  const commitMessage = parsed.values["commit-message"];
  if (commitMessage !== undefined && commitMessage.length > 500) {
    throw new CliError("--commit-message must be at most 500 characters");
  }
  const label = parsed.values.label;
  if (label !== undefined && (label.length > 36 || !/^[a-z0-9_.-]+$/.test(label) || label === "latest")) {
    throw new CliError("--label must be 1–36 lowercase letters, digits, underscores, dots, or hyphens; latest is managed automatically");
  }
  return {
    directory: resolve(parsed.positionals[0]),
    commitMessage,
    label,
    dryRun: parsed.values["dry-run"],
    recursive: parsed.values.recursive,
    updateOnly: parsed.values["update-only"],
    noLockfile: parsed.values["no-lockfile"],
    lockfile: parsed.values.lockfile,
  };
}

async function loadLocalSkills(options: PushOptions): Promise<{
  skills: LocalSkill[];
  skipped: SkippedLocalSkill[];
}> {
  const directories = options.recursive
    ? await discoverSkillDirectories(options.directory)
    : [options.directory];
  const skills: LocalSkill[] = [];
  const skipped: SkippedLocalSkill[] = [];
  const names = new Map<string, string>();

  for (const directory of directories) {
    let skill: LocalSkill;
    try {
      skill = await readLocalSkill(directory);
    } catch (error) {
      if (!options.recursive || !(error instanceof CliError) || error.exitCode !== EXIT_LOCAL) {
        throw error;
      }
      skipped.push({
        directory,
        status: "skipped",
        reason: "invalid-skill",
        message: error.message,
        ...(options.dryRun ? { dryRun: true as const } : {}),
      });
      continue;
    }
    const duplicate = names.get(skill.name);
    if (duplicate) {
      throw new CliError(
        `Multiple skill directories declare the name ${skill.name}: ${duplicate}, ${directory}`,
        EXIT_LOCAL,
      );
    }
    names.set(skill.name, directory);
    skills.push(skill);
  }
  return { skills, skipped };
}

function snapshotChanges(files: LocalSkillFile[], skill?: SkillVersion): SnapshotChanges {
  const remote = new Map(skill?.files.map((file) => [file.path, file]) ?? []);
  const changes: SnapshotChanges = { added: [], changed: [], removed: [] };

  for (const file of files) {
    const previous = remote.get(file.path);
    if (!previous) {
      changes.added.push(file.path);
    } else if (previous.sha256Hash !== file.sha256Hash || previous.contentLength !== file.contentLength) {
      changes.changed.push(file.path);
    }
    remote.delete(file.path);
  }
  changes.removed = [...remote.keys()].sort();
  return changes;
}

function hasChanges(changes: SnapshotChanges): boolean {
  return changes.added.length > 0 || changes.changed.length > 0 || changes.removed.length > 0;
}

async function planPush(config: SkillsConfig, skills: LocalSkill[]): Promise<PushPlan[]> {
  const plans: PushPlan[] = [];
  for (const local of skills) {
    const previous = await fetchLatestSkill(config, local.name);
    const changes = snapshotChanges(local.files, previous);
    plans.push({ local, previous, changes, unchanged: previous !== undefined && !hasChanges(changes) });
  }
  return plans;
}

async function publishSkill(config: SkillsConfig, plan: PushPlan, commitMessage?: string): Promise<SkillVersion> {
  const { local, previous } = plan;
  const files = local.files.map(({ path, content }) => ({ path, content }));
  const skill = await createSkillVersion(config, local.name, files, commitMessage);
  const snapshotMismatch = hasChanges(snapshotChanges(local.files, skill));
  const versionNotAdvanced = previous !== undefined && skill.version <= previous.version;
  if (snapshotMismatch || versionNotAdvanced) {
    throw new CliError("Langfuse returned a skill version that does not match the published snapshot", EXIT_RESPONSE);
  }
  return skill;
}

async function pushSkill(config: SkillsConfig, options: PushOptions, plan: PushPlan): Promise<ValidSkillResult> {
  const { local, previous, changes, unchanged } = plan;
  const result = {
    name: local.name,
    version: previous?.version ?? null,
    directory: local.directory,
    files: local.files.length,
  };

  if (options.updateOnly && !previous) {
    return {
      ...result,
      status: "skipped",
      reason: "not-found",
      ...(options.dryRun ? { dryRun: true as const } : {}),
    };
  }
  if (options.dryRun) {
    const wouldLabel = options.label !== undefined && !previous?.labels.includes(options.label);
    return {
      ...result,
      status: unchanged ? (wouldLabel ? "would-label" : "unchanged") : "would-create",
      changes,
      dryRun: true,
      ...(options.label !== undefined ? { label: options.label } : {}),
    };
  }

  const skill = unchanged ? previous! : await publishSkill(config, plan, options.commitMessage);
  return {
    ...result,
    version: skill.version,
    labels: skill.labels,
    status: unchanged ? "unchanged" : "created",
  };
}

async function labelPushedSkill(
  config: SkillsConfig,
  result: CompletedPushResult,
  label: string,
): Promise<CompletedPushResult> {
  if (result.labels.includes(label)) return result;
  const labels = [...result.labels.filter((existing) => existing !== "latest"), label];
  const skill = await setSkillLabels(config, result.name, result.version, labels);
  return { ...result, labels: skill.labels, status: result.status === "unchanged" ? "labeled" : result.status };
}

async function recordPushedSkill(lock: LangfuseSkillsLock, lockfile: string, result: CompletedPushResult, label?: string): Promise<void> {
  const lockKey = relative(dirname(lockfile), result.directory).split(sep).join("/");
  recordLockedSkill(lock, lockfile, {
    path: lockKey,
    name: result.name,
    selector: label === undefined ? { version: result.version } : { label },
    version: result.version,
  });
  await writeSkillsLock(lock, lockfile);
}

function formatPushResult(result: PushResult): string {
  if (result.status === "skipped") {
    if (result.reason === "invalid-skill") {
      return `Skipped invalid skill: ${result.message}`;
    }
    return `Skipped ${result.name}: skill does not exist in Langfuse (${result.directory})`;
  }
  if ("dryRun" in result) {
    const { added, changed, removed } = result.changes;
    const label = result.label === undefined ? "" : `; label: ${result.label}`;
    return `Dry run: ${result.name} (${added.length} added, ${changed.length} changed, ${removed.length} removed${label})`;
  }
  const action = result.status === "unchanged" ? "Already up to date"
    : result.status === "labeled" ? "Labeled" : "Published";
  return `${action}: ${result.name}@${result.version} (${result.files} files; labels: ${result.labels.join(", ")})`;
}

function pushFailure(error: unknown, skill: LocalSkill, published: string[]): CliError {
  const message = error instanceof Error ? error.message : String(error);
  const completed = published.length > 0
    ? ` Published versions remain available: ${published.join(", ")}.`
    : "";
  return new CliError(
    `Failed to push ${skill.name} at ${skill.directory}: ${message}.${completed}`,
    error instanceof CliError ? error.exitCode : 1,
  );
}

export async function runSkillsPush(config: SkillsConfig, args: string[]): Promise<void> {
  const options = parsePushOptions(args);
  let lockfile = await resolveSkillsLockPath(
    options.recursive ? options.directory : dirname(options.directory),
    options.lockfile,
    options.noLockfile,
  );
  const { skills, skipped } = await loadLocalSkills(options);
  // Recursive discovery can select the root itself; keep metadata outside its snapshot.
  if (options.recursive && options.lockfile === undefined &&
      [...skills, ...skipped].some((skill) => skill.directory === options.directory)) {
    lockfile = await resolveSkillsLockPath(dirname(options.directory), undefined, options.noLockfile);
  }
  for (const result of skipped) {
    if (!config.json) process.stdout.write(`${formatPushResult(result)}\n`);
  }
  const lock = lockfile === undefined ? undefined : await readSkillsLock(lockfile);
  if (lock) {
    await validateSkillDirectories(skills.map((skill) => skill.directory), lock, lockfile);
  }
  // Resolve all valid skills' remote versions before publishing.
  const plans = await planPush(config, skills);
  const results: PushResult[] = [...skipped];
  const published: string[] = [];

  for (const plan of plans) {
    let result: ValidSkillResult;
    try {
      result = await pushSkill(config, options, plan);
      if (result.status === "created") published.push(`${result.name}@${result.version}`);
      if ("labels" in result) {
        if (options.label !== undefined) result = await labelPushedSkill(config, result, options.label);
        if (lock && lockfile !== undefined) await recordPushedSkill(lock, lockfile, result, options.label);
      }
    } catch (error) {
      throw pushFailure(error, plan.local, published);
    }
    results.push(result);
    if (!config.json) process.stdout.write(`${formatPushResult(result)}\n`);
  }

  if (config.json) {
    process.stdout.write(`${JSON.stringify(options.recursive ? results : results[0])}\n`);
  } else if (results.length === 0) {
    process.stdout.write(`No skills found in ${options.directory}\n`);
  }
}

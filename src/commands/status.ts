import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_SETTINGS_PATH,
  GIT_COMMIT_HOOK_COMMAND,
  GIT_COMMIT_HOOK_SCRIPT_PATH,
  STOP_HOOK_COMMAND,
  STOP_HOOK_SCRIPT_PATH,
  TRACE_MANIFEST_DIR_RELATIVE,
} from "./shared/constants";
import { hasHookCommand } from "./shared/claude-settings";
import { asObject, fileExists, isExecutable, readJsonFile } from "./shared/fs";
import { canImportLangfusePython, resolveRepoRoot } from "./shared/git";
import { readTraceManifests } from "./shared/manifests";

interface StatusOptions {
  json: boolean;
}

function printStatusHelp(): void {
  console.log(`Usage: langfuse status [options]

Show Claude Code tracing setup status for the current repository.

Options:
  -h, --help              Show this help
  --json                  Output status as JSON
`);
}

function parseStatusOptions(args: string[]): StatusOptions {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printStatusHelp();
    process.exitCode = 0;
  }

  return {
    json: values.json ?? false,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export async function runStatus(args: string[]): Promise<void> {
  const options = parseStatusOptions(args);
  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  const repo = await resolveRepoRoot(process.cwd());
  const repoRoot = repo.repoRoot;

  const localSettingsPath = join(repoRoot, ".claude", "settings.local.json");
  const localSettingsExists = await fileExists(localSettingsPath);
  const localSettingsResult = await readJsonFile(localSettingsPath);
  const localSettings = localSettingsResult.data;
  const localEnv = asObject(localSettings?.env);

  const traceEnabled = localEnv?.TRACE_TO_LANGFUSE === "true";
  const hasPublicKey = typeof localEnv?.LANGFUSE_PUBLIC_KEY === "string" && localEnv.LANGFUSE_PUBLIC_KEY.length > 0;
  const hasSecretKey = typeof localEnv?.LANGFUSE_SECRET_KEY === "string" && localEnv.LANGFUSE_SECRET_KEY.length > 0;
  const hasHost =
    (typeof localEnv?.LANGFUSE_BASE_URL === "string" && localEnv.LANGFUSE_BASE_URL.length > 0) ||
    (typeof localEnv?.LANGFUSE_HOST === "string" && localEnv.LANGFUSE_HOST.length > 0);

  const globalSettingsExists = await fileExists(CLAUDE_SETTINGS_PATH);
  const globalSettingsResult = await readJsonFile(CLAUDE_SETTINGS_PATH);
  const globalSettings = globalSettingsResult.data ?? {};

  const hasStopHook = hasHookCommand(globalSettings, "Stop", STOP_HOOK_COMMAND, "");
  const hasPostToolUseHook = hasHookCommand(
    globalSettings,
    "PostToolUse",
    GIT_COMMIT_HOOK_COMMAND,
    "Bash",
  );

  const stopScriptExists = await fileExists(STOP_HOOK_SCRIPT_PATH);
  const stopScriptExecutable = stopScriptExists
    ? await isExecutable(STOP_HOOK_SCRIPT_PATH)
    : false;

  const commitScriptExists = await fileExists(GIT_COMMIT_HOOK_SCRIPT_PATH);
  const commitScriptExecutable = commitScriptExists
    ? await isExecutable(GIT_COMMIT_HOOK_SCRIPT_PATH)
    : false;

  const python = await canImportLangfusePython();

  const tracesDir = join(repoRoot, TRACE_MANIFEST_DIR_RELATIVE);
  const tracesDirExists = await fileExists(tracesDir);
  const manifests = await readTraceManifests(tracesDir);
  const latestManifest = manifests[0]?.manifest ?? null;
  const latestModifiedAt = manifests[0] ? new Date(manifests[0].mtimeMs).toISOString() : null;

  const result = {
    repoRoot,
    isGitRepo: repo.isGitRepo,
    warning: repo.warning,
    localSettings: {
      path: localSettingsPath,
      exists: localSettingsExists,
      parseError: localSettingsResult.parseError,
      traceEnabled,
      hasPublicKey,
      hasSecretKey,
      hasHost,
    },
    globalSettings: {
      path: CLAUDE_SETTINGS_PATH,
      exists: globalSettingsExists,
      parseError: globalSettingsResult.parseError,
      hasStopHook,
      hasPostToolUseHook,
    },
    scripts: {
      stop: {
        path: STOP_HOOK_SCRIPT_PATH,
        exists: stopScriptExists,
        executable: stopScriptExecutable,
      },
      postToolUse: {
        path: GIT_COMMIT_HOOK_SCRIPT_PATH,
        exists: commitScriptExists,
        executable: commitScriptExecutable,
      },
    },
    python: {
      langfuseImportable: python.ok,
      message: python.message,
    },
    traces: {
      path: tracesDir,
      exists: tracesDirExists,
      count: manifests.length,
      latestModifiedAt,
      latestTraceUrl: latestManifest?.langfuse.trace_url ?? null,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Repo root: ${result.repoRoot}`);
  if (result.warning) {
    console.log(`Warning: ${result.warning}`);
  }

  console.log("Local repo config:");
  console.log(`- ${localSettingsPath} exists: ${yesNo(result.localSettings.exists)}`);
  if (result.localSettings.parseError) {
    console.log(`- parse error: ${result.localSettings.parseError}`);
  }
  console.log(`- TRACE_TO_LANGFUSE=true: ${yesNo(result.localSettings.traceEnabled)}`);
  console.log(`- has LANGFUSE_PUBLIC_KEY: ${yesNo(result.localSettings.hasPublicKey)}`);
  console.log(`- has LANGFUSE_SECRET_KEY: ${yesNo(result.localSettings.hasSecretKey)}`);
  console.log(`- has host: ${yesNo(result.localSettings.hasHost)}`);

  console.log("Global Claude hooks:");
  console.log(`- ${CLAUDE_SETTINGS_PATH} exists: ${yesNo(result.globalSettings.exists)}`);
  if (result.globalSettings.parseError) {
    console.log(`- parse error: ${result.globalSettings.parseError}`);
  }
  console.log(`- Stop hook command present: ${yesNo(result.globalSettings.hasStopHook)}`);
  console.log(`- PostToolUse Bash hook command present: ${yesNo(result.globalSettings.hasPostToolUseHook)}`);

  console.log("Hook scripts:");
  console.log(`- ${STOP_HOOK_SCRIPT_PATH} exists: ${yesNo(result.scripts.stop.exists)}`);
  console.log(`- ${STOP_HOOK_SCRIPT_PATH} executable: ${yesNo(result.scripts.stop.executable)}`);
  console.log(`- ${GIT_COMMIT_HOOK_SCRIPT_PATH} exists: ${yesNo(result.scripts.postToolUse.exists)}`);
  console.log(`- ${GIT_COMMIT_HOOK_SCRIPT_PATH} executable: ${yesNo(result.scripts.postToolUse.executable)}`);

  console.log("Python:");
  console.log(`- python3 import langfuse: ${yesNo(result.python.langfuseImportable)}`);
  if (result.python.message) {
    console.log(`- message: ${result.python.message}`);
  }

  console.log("Trace manifests:");
  console.log(`- ${tracesDir} exists: ${yesNo(result.traces.exists)}`);
  console.log(`- manifest count: ${result.traces.count}`);
  if (result.traces.latestModifiedAt) {
    console.log(`- latest modified: ${result.traces.latestModifiedAt}`);
  }
  if (result.traces.latestTraceUrl) {
    console.log(`- latest trace URL: ${result.traces.latestTraceUrl}`);
  }
}

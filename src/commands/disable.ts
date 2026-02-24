import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_SETTINGS_PATH,
  GIT_COMMIT_HOOK_COMMAND,
  GIT_COMMIT_HOOK_SCRIPT_NAME,
  GIT_COMMIT_HOOK_SCRIPT_PATH,
  LOCAL_ENV_KEYS,
  PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
  PREPARE_COMMIT_MSG_SCRIPT_PATH,
  PREPARE_COMMIT_MSG_SENTINEL,
  SESSION_INIT_HOOK_COMMAND,
  SESSION_INIT_HOOK_SCRIPT_NAME,
  SESSION_INIT_HOOK_SCRIPT_PATH,
  STOP_HOOK_COMMAND,
  STOP_HOOK_SCRIPT_NAME,
  STOP_HOOK_SCRIPT_PATH,
} from "./shared/constants";
import { removeHookCommand, removeHookCommandsByPattern } from "./shared/claude-settings";
import { asObject, readJsonFile, type JsonObject } from "./shared/fs";
import { resolveRepoRoot } from "./shared/git";
import { removeFileIfExists, removeGitHook, writeJsonIfChanged } from "./shared/operations";

interface DisableOptions {
  dryRun: boolean;
  keepKeys: boolean;
  removeScripts: boolean;
}

function printDisableHelp(): void {
  console.log(`Usage: langfuse integration claudecode disable [options]

Disable Claude Code tracing for the current repository.

Options:
  -h, --help              Show this help
  --dry-run               Show planned changes without writing files
  --keep-keys             Keep LANGFUSE_PUBLIC_KEY/SECRET/HOST and set TRACE_TO_LANGFUSE=false
  --remove-scripts        Remove hook scripts from ~/.claude/hooks
`);
}

function parseDisableOptions(args: string[]): DisableOptions {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      "keep-keys": { type: "boolean" },
      "remove-scripts": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printDisableHelp();
    process.exitCode = 0;
  }

  return {
    dryRun: values["dry-run"] ?? false,
    keepKeys: values["keep-keys"] ?? false,
    removeScripts: values["remove-scripts"] ?? false,
  };
}

export async function runDisable(args: string[]): Promise<void> {
  const options = parseDisableOptions(args);
  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  const repo = await resolveRepoRoot(process.cwd());
  const repoRoot = repo.repoRoot;

  const changes: string[] = [];
  const warnings: string[] = [];

  if (repo.warning) {
    warnings.push(repo.warning);
  }

  const localSettingsPath = join(repoRoot, ".claude", "settings.local.json");
  const localSettingsResult = await readJsonFile(localSettingsPath);
  if (localSettingsResult.parseError) {
    throw new Error(localSettingsResult.parseError);
  }

  const localSettings: JsonObject = localSettingsResult.data ?? {};
  const localEnv = asObject(localSettings.env);
  if (localSettings.env !== undefined && !localEnv) {
    throw new Error(`Expected \"env\" to be a JSON object in ${localSettingsPath}`);
  }

  let localChanged = false;
  if (localEnv) {
    if (options.keepKeys) {
      if (localEnv.TRACE_TO_LANGFUSE !== "false") {
        localEnv.TRACE_TO_LANGFUSE = "false";
        localChanged = true;
      }
    } else {
      for (const key of LOCAL_ENV_KEYS) {
        if (key in localEnv) {
          delete localEnv[key];
          localChanged = true;
        }
      }

      if (Object.keys(localEnv).length === 0) {
        delete localSettings.env;
      }
    }
  }

  if (localChanged) {
    const result = await writeJsonIfChanged(localSettingsPath, localSettings, {
      dryRun: options.dryRun,
    });
    changes.push(result.message);
  } else {
    changes.push(`No changes: ${localSettingsPath}`);
  }

  const globalSettingsResult = await readJsonFile(CLAUDE_SETTINGS_PATH);
  if (globalSettingsResult.parseError) {
    throw new Error(globalSettingsResult.parseError);
  }

  const globalSettings: JsonObject = globalSettingsResult.data ?? {};
  const hooksObject = asObject(globalSettings.hooks);
  if (globalSettings.hooks !== undefined && !hooksObject) {
    throw new Error(`Expected \"hooks\" to be a JSON object in ${CLAUDE_SETTINGS_PATH}`);
  }
  // Remove exact command first, then also remove any variant paths (e.g.
  // .venv/bin/python3 vs plain python3).  Both must always run — using `|`
  // (non-short-circuiting) so the pattern pass cleans up variants even when
  // the exact match already succeeded.
  const removedStop =
    removeHookCommand(globalSettings, { event: "Stop", command: STOP_HOOK_COMMAND }) |
    removeHookCommandsByPattern(globalSettings, { event: "Stop", pattern: STOP_HOOK_SCRIPT_NAME });
  const removedPostToolUse =
    removeHookCommand(globalSettings, { event: "PostToolUse", command: GIT_COMMIT_HOOK_COMMAND }) |
    removeHookCommandsByPattern(globalSettings, { event: "PostToolUse", pattern: GIT_COMMIT_HOOK_SCRIPT_NAME });
  const removedPreToolUse =
    removeHookCommand(globalSettings, { event: "PreToolUse", command: SESSION_INIT_HOOK_COMMAND }) |
    removeHookCommandsByPattern(globalSettings, { event: "PreToolUse", pattern: SESSION_INIT_HOOK_SCRIPT_NAME });

  const hooks = asObject(globalSettings.hooks);
  if (hooks && Object.keys(hooks).length === 0) {
    delete globalSettings.hooks;
  }

  if (removedStop || removedPostToolUse || removedPreToolUse) {
    const result = await writeJsonIfChanged(CLAUDE_SETTINGS_PATH, globalSettings, {
      dryRun: options.dryRun,
    });
    changes.push(result.message);
  } else {
    changes.push(`No changes: ${CLAUDE_SETTINGS_PATH}`);
  }

  // Always remove the per-repo git hook
  const gitHookResult = await removeGitHook(
    repoRoot,
    "prepare-commit-msg",
    PREPARE_COMMIT_MSG_SENTINEL,
    PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
    { dryRun: options.dryRun },
  );
  changes.push(...gitHookResult.messages);

  if (options.removeScripts) {
    const removedStopScript = await removeFileIfExists(STOP_HOOK_SCRIPT_PATH, {
      dryRun: options.dryRun,
    });
    changes.push(removedStopScript.message);

    const removedCommitScript = await removeFileIfExists(GIT_COMMIT_HOOK_SCRIPT_PATH, {
      dryRun: options.dryRun,
    });
    changes.push(removedCommitScript.message);

    const removedPrepareCommitScript = await removeFileIfExists(PREPARE_COMMIT_MSG_SCRIPT_PATH, {
      dryRun: options.dryRun,
    });
    changes.push(removedPrepareCommitScript.message);

    const removedSessionInitScript = await removeFileIfExists(SESSION_INIT_HOOK_SCRIPT_PATH, {
      dryRun: options.dryRun,
    });
    changes.push(removedSessionInitScript.message);
  }

  console.log(`${options.dryRun ? "Planned" : "Applied"} disable for ${repoRoot}`);
  for (const change of changes) {
    console.log(`- ${change}`);
  }

  if (warnings.length > 0) {
    console.warn("Warnings:");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }
}

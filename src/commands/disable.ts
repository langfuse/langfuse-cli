import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  LOCAL_ENV_KEYS,
  PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
  PREPARE_COMMIT_MSG_SENTINEL,
} from "./shared/constants";
import { asObject, readJsonFile, type JsonObject } from "./shared/fs";
import { resolveRepoRoot } from "./shared/git";
import { removeGitHook, writeJsonIfChanged } from "./shared/operations";

interface DisableOptions {
  dryRun: boolean;
  keepKeys: boolean;
}

function printDisableHelp(): void {
  console.log(`Usage: langfuse integration claudecode disable [options]

Disable Claude Code tracing for the current repository.

Removes environment variables from .claude/settings.local.json and uninstalls
the per-repo prepare-commit-msg git hook. Global hook scripts in ~/.claude/hooks
are left untouched (they are shared across repos and are inert without
TRACE_TO_LANGFUSE=true).

Options:
  -h, --help              Show this help
  --dry-run               Show planned changes without writing files
  --keep-keys             Keep LANGFUSE_PUBLIC_KEY/SECRET/HOST and set TRACE_TO_LANGFUSE=false
`);
}

function parseDisableOptions(args: string[]): DisableOptions | null {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      "keep-keys": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printDisableHelp();
    return null;
  }

  return {
    dryRun: values["dry-run"] ?? false,
    keepKeys: values["keep-keys"] ?? false,
  };
}

export async function runDisable(args: string[]): Promise<void> {
  const options = parseDisableOptions(args);
  if (!options) {
    return;
  }

  const repo = await resolveRepoRoot(process.cwd());
  const repoRoot = repo.repoRoot;

  const changes: string[] = [];
  const warnings: string[] = [];

  if (repo.warning) {
    warnings.push(repo.warning);
  }

  // --- Local settings (per-repo) ---
  const localSettingsPath = join(repoRoot, ".claude", "settings.local.json");
  const localSettingsResult = await readJsonFile(localSettingsPath);
  if (localSettingsResult.parseError) {
    throw new Error(localSettingsResult.parseError);
  }

  const localSettings: JsonObject = localSettingsResult.data ?? {};
  const localEnv = asObject(localSettings.env);
  if (localSettings.env !== undefined && !localEnv) {
    throw new Error(`Expected "env" to be a JSON object in ${localSettingsPath}`);
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

  // --- Per-repo git hook ---
  const gitHookResult = await removeGitHook(
    repoRoot,
    "prepare-commit-msg",
    PREPARE_COMMIT_MSG_SENTINEL,
    PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
    { dryRun: options.dryRun },
  );
  changes.push(...gitHookResult.messages);

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

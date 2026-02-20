import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_SETTINGS_PATH,
  GIT_COMMIT_HOOK_COMMAND,
  GIT_COMMIT_HOOK_SCRIPT_PATH,
  STOP_HOOK_COMMAND,
  STOP_HOOK_SCRIPT_PATH,
} from "./shared/constants";
import { ensureHookCommand } from "./shared/claude-settings";
import { asObject, readJsonFile, type JsonObject } from "./shared/fs";
import { resolveRepoRoot } from "./shared/git";
import { GIT_COMMIT_HOOK_SCRIPT, STOP_HOOK_SCRIPT } from "./shared/hook-scripts";
import {
  addGitignoreEntries,
  installScriptFile,
  writeJsonIfChanged,
} from "./shared/operations";
import type { GlobalAuthOptions } from "./shared/types";

interface EnableOptions {
  yes: boolean;
  nonInteractive: boolean;
  dryRun: boolean;
  noGitignore: boolean;
  force: boolean;
}

function printEnableHelp(): void {
  console.log(`Usage: langfuse enable [options]

Enable Claude Code tracing for the current repository.

Options:
  -h, --help              Show this help
  -y, --yes               Non-interactive mode (same as --non-interactive)
  --non-interactive       Fail if required values are missing
  --dry-run               Show planned changes without writing files
  --no-gitignore          Skip .gitignore updates
  --force                 Replace existing hook scripts (creates .bak backup)
`);
}

async function promptForValue(label: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const value = (await rl.question(`${label}: `)).trim();
    return value;
  } finally {
    rl.close();
  }
}

async function resolveCredentials(
  auth: GlobalAuthOptions,
  options: EnableOptions,
): Promise<{ publicKey: string; secretKey: string; host: string }> {
  let publicKey = auth.publicKey?.trim() ?? "";
  let secretKey = auth.secretKey?.trim() ?? "";
  const host = auth.host.trim();

  const nonInteractive = options.nonInteractive || options.yes;

  if (!publicKey) {
    if (nonInteractive) {
      throw new Error(
        "Missing Langfuse public key. Provide --public-key, LANGFUSE_PUBLIC_KEY, or run interactively.",
      );
    }
    publicKey = await promptForValue("Langfuse public key");
  }

  if (!secretKey) {
    if (nonInteractive) {
      throw new Error(
        "Missing Langfuse secret key. Provide --secret-key, LANGFUSE_SECRET_KEY, or run interactively.",
      );
    }
    secretKey = await promptForValue("Langfuse secret key");
  }

  if (!publicKey || !secretKey) {
    throw new Error("Both Langfuse public and secret keys are required.");
  }

  return { publicKey, secretKey, host };
}

function parseEnableOptions(args: string[]): EnableOptions {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
      "non-interactive": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-gitignore": { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printEnableHelp();
    process.exitCode = 0;
  }

  return {
    yes: values.yes ?? false,
    nonInteractive: values["non-interactive"] ?? false,
    dryRun: values["dry-run"] ?? false,
    noGitignore: values["no-gitignore"] ?? false,
    force: values.force ?? false,
  };
}

export async function runEnable(args: string[], auth: GlobalAuthOptions): Promise<void> {
  const options = parseEnableOptions(args);
  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  const credentials = await resolveCredentials(auth, options);

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
  const localEnvObject = asObject(localSettings.env);
  if (localSettings.env !== undefined && !localEnvObject) {
    throw new Error(`Expected \"env\" to be a JSON object in ${localSettingsPath}`);
  }
  const localEnv = localEnvObject ?? {};

  localEnv.TRACE_TO_LANGFUSE = "true";
  localEnv.LANGFUSE_PUBLIC_KEY = credentials.publicKey;
  localEnv.LANGFUSE_SECRET_KEY = credentials.secretKey;
  localEnv.LANGFUSE_BASE_URL = credentials.host;
  localSettings.env = localEnv;

  const localWriteResult = await writeJsonIfChanged(localSettingsPath, localSettings, {
    dryRun: options.dryRun,
  });
  changes.push(localWriteResult.message);

  const globalSettingsResult = await readJsonFile(CLAUDE_SETTINGS_PATH);
  if (globalSettingsResult.parseError) {
    throw new Error(globalSettingsResult.parseError);
  }

  const globalSettings: JsonObject = globalSettingsResult.data ?? {};
  const existingHooks = asObject(globalSettings.hooks);
  if (globalSettings.hooks !== undefined && !existingHooks) {
    throw new Error(`Expected \"hooks\" to be a JSON object in ${CLAUDE_SETTINGS_PATH}`);
  }
  const stopChanged = ensureHookCommand(globalSettings, {
    event: "Stop",
    matcher: "",
    command: STOP_HOOK_COMMAND,
  });
  const postToolUseChanged = ensureHookCommand(globalSettings, {
    event: "PostToolUse",
    matcher: "Bash",
    command: GIT_COMMIT_HOOK_COMMAND,
  });

  if (stopChanged || postToolUseChanged) {
    const globalWriteResult = await writeJsonIfChanged(CLAUDE_SETTINGS_PATH, globalSettings, {
      dryRun: options.dryRun,
    });
    changes.push(globalWriteResult.message);
  } else {
    changes.push(`No changes: ${CLAUDE_SETTINGS_PATH}`);
  }

  const stopInstallResult = await installScriptFile(STOP_HOOK_SCRIPT_PATH, STOP_HOOK_SCRIPT, {
    dryRun: options.dryRun,
    force: options.force,
  });
  changes.push(...stopInstallResult.messages);
  warnings.push(...stopInstallResult.warnings);

  const commitInstallResult = await installScriptFile(
    GIT_COMMIT_HOOK_SCRIPT_PATH,
    GIT_COMMIT_HOOK_SCRIPT,
    {
      dryRun: options.dryRun,
      force: options.force,
    },
  );
  changes.push(...commitInstallResult.messages);
  warnings.push(...commitInstallResult.warnings);

  if (!options.noGitignore) {
    const gitignoreResult = await addGitignoreEntries(
      repoRoot,
      [".langfuse/current-session.json"],
      {
        dryRun: options.dryRun,
      },
    );
    changes.push(gitignoreResult.message);
  }

  console.log(
    `${options.dryRun ? "Planned" : "Applied"} langfuse setup for ${repoRoot}`,
  );
  for (const change of changes) {
    console.log(`- ${change}`);
  }

  console.log("- Hook commands:");
  console.log(`  Stop -> ${STOP_HOOK_COMMAND}`);
  console.log(`  PostToolUse (Bash) -> ${GIT_COMMIT_HOOK_COMMAND}`);

  if (warnings.length > 0) {
    console.warn("Warnings:");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }
}

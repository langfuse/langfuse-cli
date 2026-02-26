import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_SETTINGS_PATH,
  DEFAULT_HOST,
  GIT_COMMIT_HOOK_SCRIPT_PATH,
  PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
  PREPARE_COMMIT_MSG_SCRIPT_PATH,
  PREPARE_COMMIT_MSG_SENTINEL,
  SESSION_END_HOOK_COMMAND,
  SESSION_INIT_HOOK_SCRIPT_PATH,
  STOP_HOOK_SCRIPT_PATH,
  STOP_HOOK_COMMAND,
  GIT_COMMIT_HOOK_COMMAND,
  SESSION_INIT_HOOK_COMMAND,
  UTILS_SCRIPT_PATH,
} from "./shared/constants";
import { ensureHookCommand } from "./shared/claude-settings";
import { parseEnvContent } from "./shared/env";
import { asObject, readJsonFile, readTextFile, type JsonObject } from "./shared/fs";
import { resolveRepoRoot } from "./shared/git";
import {
  getGitCommitHookScript,
  getPrepareCommitMsgHookScript,
  getSessionInitHookScript,
  getStopHookScript,
  getUtilsScript,
  PREPARE_COMMIT_MSG_WRAPPER_SCRIPT,
} from "./shared/hook-scripts";
import {
  addGitignoreEntries,
  installGitHook,
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
  skipValidation: boolean;
}

function printEnableHelp(): void {
  console.log(`Usage: langfuse integration claudecode enable [options]

Enable Claude Code tracing for the current repository. (Beta)

Options:
  -h, --help              Show this help
  -y, --yes               Non-interactive mode (same as --non-interactive)
  --non-interactive       Fail if required values are missing
  --dry-run               Show planned changes without writing files
  --no-gitignore          Skip .gitignore updates
  --force                 Replace existing hook scripts (creates .bak backup)
  --skip-validation       Skip credential validation
`);
}

const LANGFUSE_REGIONS = [
  { label: "EU (Ireland)", url: "https://cloud.langfuse.com" },
  { label: "US (Oregon)", url: "https://us.cloud.langfuse.com" },
  { label: "HIPAA (Oregon)", url: "https://hipaa.cloud.langfuse.com" },
] as const;

async function promptForValue(label: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const value = (await rl.question(`${label}: `)).trim();
    return value;
  } finally {
    rl.close();
  }
}

async function promptForConfirmation(label: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${label} [Y/n]: `)).trim().toLowerCase();
    if (!answer) {
      return true;
    }
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptForRegion(): Promise<string> {
  console.log("\nSelect your Langfuse data region:");
  for (let i = 0; i < LANGFUSE_REGIONS.length; i++) {
    const r = LANGFUSE_REGIONS[i];
    console.log(`  ${i + 1}) ${r.label} — ${r.url}`);
  }
  console.log(`  ${LANGFUSE_REGIONS.length + 1}) Self-hosted (enter custom URL)`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Choice [1]: `)).trim();
    if (!answer || answer === "1") {
      return LANGFUSE_REGIONS[0].url;
    }
    const idx = Number.parseInt(answer, 10);
    if (idx >= 1 && idx <= LANGFUSE_REGIONS.length) {
      return LANGFUSE_REGIONS[idx - 1].url;
    }
    if (idx === LANGFUSE_REGIONS.length + 1) {
      const customUrl = await promptForValue("Langfuse base URL");
      if (!customUrl) {
        throw new Error("No base URL provided.");
      }
      return customUrl.replace(/\/+$/, "");
    }
    throw new Error(`Invalid selection: ${answer}`);
  } finally {
    rl.close();
  }
}

async function readLangfuseEnvFromDotEnv(repoRoot: string): Promise<{
  path: string;
  publicKey: string;
  secretKey: string;
  host: string | null;
} | null> {
  const dotenvPath = join(repoRoot, ".env");
  const content = await readTextFile(dotenvPath);
  if (content == null) {
    return null;
  }

  const values = parseEnvContent(content);
  const publicKey = (values.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (values.LANGFUSE_SECRET_KEY ?? "").trim();
  const hostRaw = (values.LANGFUSE_BASE_URL ?? values.LANGFUSE_HOST ?? "").trim();

  if (!publicKey || !secretKey) {
    return null;
  }

  return {
    path: dotenvPath,
    publicKey,
    secretKey,
    host: hostRaw ? hostRaw.replace(/\/+$/, "") : null,
  };
}

async function validateCredentials(
  host: string,
  publicKey: string,
  secretKey: string,
): Promise<{ ok: boolean; message: string | null; projectId: string | null }> {
  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const response = await fetch(`${host}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      let projectId: string | null = null;
      try {
        const body = (await response.json()) as Record<string, unknown>;
        // The API may return { id: "..." } or { data: [{ id: "..." }] }
        if (typeof body.id === "string") {
          projectId = body.id;
        } else if (Array.isArray(body.data) && body.data.length > 0) {
          const first = body.data[0] as Record<string, unknown>;
          if (typeof first.id === "string") {
            projectId = first.id;
          }
        }
      } catch {
        // JSON parsing failure is non-fatal; we still validated successfully
      }
      return { ok: true, message: null, projectId };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `Authentication failed (HTTP ${response.status}). Check your public/secret keys.`, projectId: null };
    }
    return { ok: false, message: `Unexpected response from ${host} (HTTP ${response.status}).`, projectId: null };
  } catch (error) {
    return { ok: false, message: `Could not reach ${host}: ${(error as Error).message}`, projectId: null };
  }
}

async function resolveCredentials(
  auth: GlobalAuthOptions,
  options: EnableOptions,
  repoRoot: string,
): Promise<{ publicKey: string; secretKey: string; host: string }> {
  let publicKey = auth.publicKey?.trim() ?? "";
  let secretKey = auth.secretKey?.trim() ?? "";
  let host = auth.host.trim();

  const nonInteractive = options.nonInteractive || options.yes;

  const hostExplicitFromEnv =
    !!process.env.LANGFUSE_BASE_URL || !!process.env.LANGFUSE_HOST;
  const hostExplicitFromFlag = host !== DEFAULT_HOST;

  const dotenvCredentials = await readLangfuseEnvFromDotEnv(repoRoot);
  if (dotenvCredentials) {
    const useDotEnv = nonInteractive
      ? true
      : await promptForConfirmation(
          `Detected Langfuse credentials in ${dotenvCredentials.path}. Use them?`,
        );

    if (useDotEnv) {
      publicKey = dotenvCredentials.publicKey;
      secretKey = dotenvCredentials.secretKey;
      if (dotenvCredentials.host) {
        host = dotenvCredentials.host;
      }
    }
  }

  const hostResolved =
    hostExplicitFromFlag ||
    hostExplicitFromEnv ||
    (dotenvCredentials?.host != null && host !== DEFAULT_HOST);

  if (!hostResolved && !nonInteractive) {
    host = await promptForRegion();
  }

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

function parseEnableOptions(args: string[]): EnableOptions | null {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
      "non-interactive": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-gitignore": { type: "boolean" },
      force: { type: "boolean" },
      "skip-validation": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printEnableHelp();
    return null;
  }

  return {
    yes: values.yes ?? false,
    nonInteractive: values["non-interactive"] ?? false,
    dryRun: values["dry-run"] ?? false,
    noGitignore: values["no-gitignore"] ?? false,
    force: values.force ?? false,
    skipValidation: values["skip-validation"] ?? false,
  };
}

export async function runEnable(args: string[], auth: GlobalAuthOptions): Promise<void> {
  const options = parseEnableOptions(args);
  if (!options) {
    return;
  }

  const repo = await resolveRepoRoot(process.cwd());
  const repoRoot = repo.repoRoot;
  const credentials = await resolveCredentials(auth, options, repoRoot);

  let projectId: string | null = null;
  if (!options.skipValidation && !options.dryRun) {
    const validation = await validateCredentials(
      credentials.host,
      credentials.publicKey,
      credentials.secretKey,
    );
    if (!validation.ok) {
      console.warn(`Warning: Credential validation failed — ${validation.message}`);
      console.warn("Continuing with setup. Hooks will fail silently until credentials are fixed.");
    }
    if (validation.projectId) {
      projectId = validation.projectId;
    }
  }

  const changes: string[] = [];
  const warnings: string[] = [];

  if (repo.warning) {
    warnings.push(repo.warning);
  }

  // --- Local settings (per-repo credentials) ---
  const localSettingsPath = join(repoRoot, ".claude", "settings.local.json");
  const localSettingsResult = await readJsonFile(localSettingsPath);
  if (localSettingsResult.parseError) {
    throw new Error(localSettingsResult.parseError);
  }

  const localSettings: JsonObject = localSettingsResult.data ?? {};
  const localEnvObject = asObject(localSettings.env);
  if (localSettings.env !== undefined && !localEnvObject) {
    throw new Error(`Expected "env" to be a JSON object in ${localSettingsPath}`);
  }
  const localEnv = localEnvObject ?? {};

  localEnv.TRACE_TO_LANGFUSE = "true";
  localEnv.LANGFUSE_PUBLIC_KEY = credentials.publicKey;
  localEnv.LANGFUSE_SECRET_KEY = credentials.secretKey;
  localEnv.LANGFUSE_BASE_URL = credentials.host;
  if (projectId) {
    localEnv.LANGFUSE_PROJECT_ID = projectId;
  }
  localSettings.env = localEnv;

  const localWriteResult = await writeJsonIfChanged(localSettingsPath, localSettings, {
    dryRun: options.dryRun,
  });
  changes.push(localWriteResult.message);

  // --- Global settings (hook commands) ---
  const globalSettingsResult = await readJsonFile(CLAUDE_SETTINGS_PATH);
  if (globalSettingsResult.parseError) {
    throw new Error(globalSettingsResult.parseError);
  }

  const globalSettings: JsonObject = globalSettingsResult.data ?? {};
  const existingHooks = asObject(globalSettings.hooks);
  if (globalSettings.hooks !== undefined && !existingHooks) {
    throw new Error(`Expected "hooks" to be a JSON object in ${CLAUDE_SETTINGS_PATH}`);
  }
  const stopChanged = ensureHookCommand(globalSettings, {
    event: "Stop",
    matcher: "",
    command: STOP_HOOK_COMMAND,
  });
  const sessionEndChanged = ensureHookCommand(globalSettings, {
    event: "SessionEnd",
    matcher: "",
    command: SESSION_END_HOOK_COMMAND,
  });
  const postToolUseChanged = ensureHookCommand(globalSettings, {
    event: "PostToolUse",
    matcher: "Bash",
    command: GIT_COMMIT_HOOK_COMMAND,
  });
  const preToolUseChanged = ensureHookCommand(globalSettings, {
    event: "PreToolUse",
    matcher: "",
    command: SESSION_INIT_HOOK_COMMAND,
  });

  if (stopChanged || sessionEndChanged || postToolUseChanged || preToolUseChanged) {
    const globalWriteResult = await writeJsonIfChanged(CLAUDE_SETTINGS_PATH, globalSettings, {
      dryRun: options.dryRun,
    });
    changes.push(globalWriteResult.message);
  } else {
    changes.push(`No changes: ${CLAUDE_SETTINGS_PATH}`);
  }

  // --- Hook scripts ---
  const scriptInstalls: Array<{ path: string; content: string }> = [
    { path: UTILS_SCRIPT_PATH, content: getUtilsScript() },
    { path: STOP_HOOK_SCRIPT_PATH, content: getStopHookScript() },
    { path: GIT_COMMIT_HOOK_SCRIPT_PATH, content: getGitCommitHookScript() },
    { path: SESSION_INIT_HOOK_SCRIPT_PATH, content: getSessionInitHookScript() },
    { path: PREPARE_COMMIT_MSG_SCRIPT_PATH, content: getPrepareCommitMsgHookScript() },
  ];
  for (const script of scriptInstalls) {
    const result = await installScriptFile(script.path, script.content, {
      dryRun: options.dryRun,
      force: options.force,
    });
    changes.push(...result.messages);
    warnings.push(...result.warnings);
  }

  // --- Per-repo git hook ---
  if (repo.isGitRepo) {
    const gitHookResult = await installGitHook(
      repoRoot,
      "prepare-commit-msg",
      PREPARE_COMMIT_MSG_WRAPPER_SCRIPT,
      PREPARE_COMMIT_MSG_SENTINEL,
      PREPARE_COMMIT_MSG_BACKUP_SUFFIX,
      {
        dryRun: options.dryRun,
        force: options.force,
      },
    );
    changes.push(...gitHookResult.messages);
    warnings.push(...gitHookResult.warnings);
  } else {
    warnings.push("Not a git repository, skipping prepare-commit-msg git hook installation");
  }

  // --- .gitignore ---
  if (!options.noGitignore) {
    const gitignoreResult = await addGitignoreEntries(
      repoRoot,
      [".langfuse/", ".claude/settings.local.json"],
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
  console.log(`  PreToolUse -> ${SESSION_INIT_HOOK_COMMAND}`);
  console.log(`  Stop -> ${STOP_HOOK_COMMAND}`);
  console.log(`  SessionEnd -> ${SESSION_END_HOOK_COMMAND}`);
  console.log(`  PostToolUse (Bash) -> ${GIT_COMMIT_HOOK_COMMAND}`);

  if (warnings.length > 0) {
    console.warn("Warnings:");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }
}

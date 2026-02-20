import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = "https://cloud.langfuse.com";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
export const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, "hooks");

export const STOP_HOOK_SCRIPT_NAME = "langfuse_hook.py";
export const GIT_COMMIT_HOOK_SCRIPT_NAME = "langfuse_git_commit_hook.py";

export const STOP_HOOK_SCRIPT_PATH = join(CLAUDE_HOOKS_DIR, STOP_HOOK_SCRIPT_NAME);
export const GIT_COMMIT_HOOK_SCRIPT_PATH = join(
  CLAUDE_HOOKS_DIR,
  GIT_COMMIT_HOOK_SCRIPT_NAME,
);

export const STOP_HOOK_COMMAND = "python3 ~/.claude/hooks/langfuse_hook.py";
export const GIT_COMMIT_HOOK_COMMAND =
  "python3 ~/.claude/hooks/langfuse_git_commit_hook.py";

export const TRACE_SESSION_FILE_RELATIVE = ".langfuse/current-session.json";
export const TRACE_MANIFEST_DIR_RELATIVE = ".langfuse/traces";

export const LOCAL_ENV_KEYS = [
  "TRACE_TO_LANGFUSE",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_HOST",
] as const;

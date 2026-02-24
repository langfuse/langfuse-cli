import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveHooksDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "hooks"))) {
      return join(dir, "hooks");
    }
    dir = dirname(dir);
  }
  throw new Error("Could not find hooks directory (no package.json + hooks/ found)");
}

let _hooksDir: string | null = null;
function getHooksDir(): string {
  if (!_hooksDir) {
    _hooksDir = resolveHooksDir();
  }
  return _hooksDir;
}

function readHookFile(filename: string): string {
  return readFileSync(join(getHooksDir(), filename), "utf-8");
}

export function getUtilsScript(): string {
  return readHookFile("langfuse_utils.py");
}

export function getStopHookScript(): string {
  return readHookFile("langfuse_hook.py");
}

export function getGitCommitHookScript(): string {
  return readHookFile("langfuse_git_commit_hook.py");
}

export function getSessionInitHookScript(): string {
  return readHookFile("langfuse_session_init_hook.py");
}

export function getPrepareCommitMsgHookScript(): string {
  return readHookFile("langfuse_prepare_commit_msg.py");
}

export const PREPARE_COMMIT_MSG_WRAPPER_SCRIPT = `#!/bin/sh
# langfuse-trace-trailer — installed by langfuse-cli
python3 ~/.claude/hooks/langfuse_prepare_commit_msg.py "$@" 2>/dev/null || true
# Chain pre-existing hook if backed up
if [ -x "$(dirname "$0")/prepare-commit-msg.pre-langfuse" ]; then
    "$(dirname "$0")/prepare-commit-msg.pre-langfuse" "$@"
fi
`;

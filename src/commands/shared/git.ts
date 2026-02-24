import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface RepoRootResult {
  repoRoot: string;
  isGitRepo: boolean;
  warning: string | null;
}

export async function resolveRepoRoot(cwd: string): Promise<RepoRootResult> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });

    const repoRoot = stdout.trim();
    if (!repoRoot) {
      return {
        repoRoot: cwd,
        isGitRepo: false,
        warning: "Could not determine git repo root. Using current working directory.",
      };
    }

    return { repoRoot, isGitRepo: true, warning: null };
  } catch {
    return {
      repoRoot: cwd,
      isGitRepo: false,
      warning: "Not inside a git repository. Using current working directory.",
    };
  }
}

export async function canImportLangfusePython(): Promise<{ ok: boolean; message: string | null }> {
  try {
    await execFile("python3", ["-c", "import langfuse"], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, message: null };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return {
      ok: false,
      message: stderr || "python3 could not import langfuse",
    };
  }
}

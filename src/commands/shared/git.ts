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

export async function installLangfusePythonPackage(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFile("python3", ["-m", "pip", "install", "langfuse"], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    return { ok: true, message: "Installed langfuse Python package" };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";
    return {
      ok: false,
      message: `Failed to install langfuse Python package: ${stderr || (error as Error).message}`,
    };
  }
}

export async function ensureLangfusePythonPackage(
  options: { dryRun: boolean },
): Promise<{ changed: boolean; messages: string[]; warnings: string[] }> {
  const messages: string[] = [];
  const warnings: string[] = [];

  const check = await canImportLangfusePython();
  if (check.ok) {
    messages.push("langfuse Python package already installed");
    return { changed: false, messages, warnings };
  }

  if (options.dryRun) {
    messages.push("Would install langfuse Python package via pip");
    return { changed: false, messages, warnings };
  }

  const install = await installLangfusePythonPackage();
  if (install.ok) {
    messages.push(install.message);
    return { changed: true, messages, warnings };
  }

  warnings.push(install.message);
  warnings.push("Hooks will silently do nothing until langfuse is installed: pip install langfuse");
  return { changed: false, messages, warnings };
}

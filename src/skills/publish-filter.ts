import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { CliError, EXIT_LOCAL } from "../errors";

const execFileAsync = promisify(execFile);

export type ExclusionReason = "gitignore" | "exclude" | "git-metadata";
export interface ExcludedPath {
  path: string;
  reason: ExclusionReason;
}

export class GitIgnoreError extends CliError {
  constructor(directory: string, error: unknown) {
    super(`Cannot apply Git ignore rules at ${directory}; check that Git is installed and the checkout is readable: ${error instanceof Error ? error.message : String(error)}`, EXIT_LOCAL);
  }
}

export interface GitSelection {
  directory: string;
  paths?: Set<string>;
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readGitSelection(directory: string, parent?: GitSelection): Promise<GitSelection> {
  try {
    const fromParent = parent && relative(parent.directory, directory);
    if (parent && fromParent !== undefined && !isAbsolute(fromParent) &&
        fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !await hasGitMetadata(directory)) {
      return parent;
    }
    let ancestor = directory;
    while (!await hasGitMetadata(ancestor)) {
      const next = dirname(ancestor);
      if (next === ancestor) return { directory };
      ancestor = next;
    }

    const { stdout } = await execFileAsync("git", [
      "--literal-pathspecs", "-c", "core.fsmonitor=false",
      "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".",
    ], {
      cwd: directory,
      // Inspect this checkout even when invoked from a Git hook or other Git process.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_OPTIONAL_LOCKS: "0" },
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const paths = new Set<string>();
    for (const path of stdout.split("\0").filter(Boolean)) {
      const segments = path.replace(/\/$/, "").split("/");
      for (let length = 1; length <= segments.length; length++) {
        paths.add(segments.slice(0, length).join("/"));
      }
    }
    return { directory, paths };
  } catch (error) {
    throw new GitIgnoreError(directory, error);
  }
}

export function gitExcludes(selection: GitSelection, path: string): boolean {
  return selection.paths !== undefined && !selection.paths.has(relative(selection.directory, path).split(sep).join("/"));
}

export function parsePublishExclusions(paths: string[]): string[] {
  return paths.map((value) => {
    const path = value.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!path || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new CliError("--exclude requires a relative file or directory path within each skill");
    }
    return path;
  });
}

export function publishExclusion(path: string, exclusions: string[] = []): ExclusionReason | undefined {
  if (path.split("/").some((part) => [".git", ".gitignore"].includes(part.toLowerCase()))) return "git-metadata";
  if (exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) return "exclude";
  return undefined;
}

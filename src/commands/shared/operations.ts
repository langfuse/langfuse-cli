import { dirname, join } from "node:path";
import {
  backupFile,
  copyFileTo,
  ensureDir,
  fileExists,
  maybeChmodExecutable,
  readTextFile,
  removeFile,
  stableJson,
  writeJsonAtomic,
  writeTextAtomic,
  type JsonObject,
} from "./fs";

export interface WriteOptions {
  dryRun: boolean;
}

export async function writeJsonIfChanged(
  path: string,
  value: JsonObject,
  options: WriteOptions,
): Promise<{ changed: boolean; message: string }> {
  const currentText = await readTextFile(path);
  const nextText = stableJson(value);

  if (currentText === nextText) {
    return { changed: false, message: `No changes: ${path}` };
  }

  if (!options.dryRun) {
    await writeJsonAtomic(path, value);
  }

  return {
    changed: true,
    message: `${options.dryRun ? "Would update" : "Updated"} ${path}`,
  };
}

export async function installScriptFile(
  path: string,
  content: string,
  options: { dryRun: boolean; force: boolean },
): Promise<{ changed: boolean; warnings: string[]; messages: string[] }> {
  const warnings: string[] = [];
  const messages: string[] = [];

  const exists = await fileExists(path);
  if (!exists) {
    if (!options.dryRun) {
      await ensureDir(dirname(path));
      await writeTextAtomic(path, content);
      await maybeChmodExecutable(path);
    }

    messages.push(`${options.dryRun ? "Would install" : "Installed"} ${path}`);
    return { changed: true, warnings, messages };
  }

  const current = (await readTextFile(path)) ?? "";
  if (current === content) {
    if (!options.dryRun) {
      await maybeChmodExecutable(path);
    }
    messages.push(`Already up to date: ${path}`);
    return { changed: false, warnings, messages };
  }

  if (!options.force) {
    warnings.push(`Skipped existing modified file (use --force to replace): ${path}`);
    return { changed: false, warnings, messages };
  }

  if (!options.dryRun) {
    const backupPath = await backupFile(path);
    await writeTextAtomic(path, content);
    await maybeChmodExecutable(path);
    messages.push(`Backed up ${path} to ${backupPath}`);
  } else {
    messages.push(`Would back up and replace ${path}`);
  }

  messages.push(`${options.dryRun ? "Would update" : "Updated"} ${path}`);
  return { changed: true, warnings, messages };
}

export async function addGitignoreEntries(
  repoRoot: string,
  entries: string[],
  options: WriteOptions,
): Promise<{ changed: boolean; message: string }> {
  const gitignorePath = join(repoRoot, ".gitignore");
  const current = (await readTextFile(gitignorePath)) ?? "";

  const lines = current.split(/\r?\n/);
  let changed = false;

  for (const entry of entries) {
    if (!lines.includes(entry)) {
      lines.push(entry);
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, message: `No changes: ${gitignorePath}` };
  }

  const normalized = lines.join("\n").replace(/\n*$/, "\n");

  if (!options.dryRun) {
    await ensureDir(repoRoot);
    await writeTextAtomic(gitignorePath, normalized);
  }

  return {
    changed: true,
    message: `${options.dryRun ? "Would update" : "Updated"} ${gitignorePath}`,
  };
}

export async function installGitHook(
  repoRoot: string,
  hookName: string,
  content: string,
  sentinel: string,
  backupSuffix: string,
  options: { dryRun: boolean; force: boolean },
): Promise<{ changed: boolean; warnings: string[]; messages: string[] }> {
  const warnings: string[] = [];
  const messages: string[] = [];
  const hookPath = join(repoRoot, ".git", "hooks", hookName);
  const backupPath = `${hookPath}${backupSuffix}`;

  const hooksDir = join(repoRoot, ".git", "hooks");
  const gitDirExists = await fileExists(join(repoRoot, ".git"));
  if (!gitDirExists) {
    warnings.push(`Not a git repository, skipping ${hookName} git hook`);
    return { changed: false, warnings, messages };
  }

  const exists = await fileExists(hookPath);
  if (!exists) {
    if (!options.dryRun) {
      await ensureDir(hooksDir);
      await writeTextAtomic(hookPath, content);
      await maybeChmodExecutable(hookPath);
    }
    messages.push(`${options.dryRun ? "Would install" : "Installed"} ${hookPath}`);
    return { changed: true, warnings, messages };
  }

  const current = (await readTextFile(hookPath)) ?? "";

  // Already our hook and up to date
  if (current === content) {
    if (!options.dryRun) {
      await maybeChmodExecutable(hookPath);
    }
    messages.push(`Already up to date: ${hookPath}`);
    return { changed: false, warnings, messages };
  }

  // Our hook but outdated — replace in place
  if (current.includes(sentinel)) {
    if (!options.dryRun) {
      await writeTextAtomic(hookPath, content);
      await maybeChmodExecutable(hookPath);
    }
    messages.push(`${options.dryRun ? "Would update" : "Updated"} ${hookPath}`);
    return { changed: true, warnings, messages };
  }

  // Pre-existing non-langfuse hook
  if (!options.force) {
    warnings.push(`Skipped existing ${hookName} hook (use --force to replace): ${hookPath}`);
    return { changed: false, warnings, messages };
  }

  if (!options.dryRun) {
    await copyFileTo(hookPath, backupPath);
    await maybeChmodExecutable(backupPath);
    await writeTextAtomic(hookPath, content);
    await maybeChmodExecutable(hookPath);
    messages.push(`Backed up ${hookPath} to ${backupPath}`);
  } else {
    messages.push(`Would back up ${hookPath} to ${backupPath}`);
  }

  messages.push(`${options.dryRun ? "Would install" : "Installed"} ${hookPath}`);
  return { changed: true, warnings, messages };
}

export async function removeGitHook(
  repoRoot: string,
  hookName: string,
  sentinel: string,
  backupSuffix: string,
  options: WriteOptions,
): Promise<{ changed: boolean; messages: string[] }> {
  const messages: string[] = [];
  const hookPath = join(repoRoot, ".git", "hooks", hookName);
  const backupPath = `${hookPath}${backupSuffix}`;

  const exists = await fileExists(hookPath);
  if (!exists) {
    messages.push(`Not found: ${hookPath}`);
    return { changed: false, messages };
  }

  const current = (await readTextFile(hookPath)) ?? "";
  if (!current.includes(sentinel)) {
    messages.push(`Skipped ${hookPath} (not installed by langfuse-cli)`);
    return { changed: false, messages };
  }

  if (!options.dryRun) {
    await removeFile(hookPath);
  }
  messages.push(`${options.dryRun ? "Would remove" : "Removed"} ${hookPath}`);

  // Restore backup if it exists
  const backupExists = await fileExists(backupPath);
  if (backupExists) {
    if (!options.dryRun) {
      await copyFileTo(backupPath, hookPath);
      await maybeChmodExecutable(hookPath);
      await removeFile(backupPath);
    }
    messages.push(`${options.dryRun ? "Would restore" : "Restored"} ${backupPath} to ${hookPath}`);
  }

  return { changed: true, messages };
}

export async function removeFileIfExists(
  path: string,
  options: WriteOptions,
): Promise<{ changed: boolean; message: string }> {
  const exists = await fileExists(path);
  if (!exists) {
    return { changed: false, message: `Not found: ${path}` };
  }

  if (!options.dryRun) {
    await removeFile(path);
  }

  return {
    changed: true,
    message: `${options.dryRun ? "Would remove" : "Removed"} ${path}`,
  };
}

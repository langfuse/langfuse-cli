import { dirname, join } from "node:path";
import {
  backupFile,
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

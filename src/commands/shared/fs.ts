import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readJsonFile(path: string): Promise<{ data: JsonObject | null; parseError: string | null }> {
  const text = await readTextFile(path);
  if (text == null) {
    return { data: null, parseError: null };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const obj = asObject(parsed);
    if (!obj) {
      return { data: null, parseError: `Expected JSON object in ${path}` };
    }
    return { data: obj, parseError: null };
  } catch (error) {
    return {
      data: null,
      parseError: `Invalid JSON in ${path}: ${(error as Error).message}`,
    };
  }
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await ensureDir(parent);

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, stableJson(value));
}

export async function maybeChmodExecutable(path: string): Promise<void> {
  await chmod(path, 0o755);
}

export async function backupFile(path: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.${timestamp}.bak`;
  await copyFile(path, backupPath);
  return backupPath;
}

export async function copyFileTo(src: string, dest: string): Promise<void> {
  await copyFile(src, dest);
}

export async function removeFile(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function fileMtime(path: string): Promise<Date | null> {
  try {
    const result = await stat(path);
    return result.mtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

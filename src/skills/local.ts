import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError, EXIT_LOCAL } from "../errors";
import type { SkillFile } from "./api";

export function decodeSkillContent(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF+/, "");
}

function matchesFileHash(bytes: Uint8Array, expected: SkillFile): boolean {
  return bytes.byteLength === expected.contentLength &&
    createHash("sha256").update(bytes).digest("base64") === expected.sha256Hash;
}

export async function matchesManifest(directory: string, files: SkillFile[]): Promise<boolean> {
  const remaining = new Map(files.map((file) => [file.path, file]));
  const directories = [""];
  try {
    // An installation must contain real files, not links to content elsewhere.
    if (!(await lstat(directory)).isDirectory()) return false;
    while (directories.length > 0) {
      const parent = directories.pop()!;
      for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          directories.push(path);
          continue;
        }
        const expected = remaining.get(path);
        if (!entry.isFile() || !expected) return false;
        const bytes = await readFile(join(directory, path));
        if (!matchesFileHash(bytes, expected)) {
          let content: string;
          try {
            content = decodeSkillContent(bytes);
          } catch {
            return false;
          }
          if (!matchesFileHash(Buffer.from(content), expected)) return false;
        }
        remaining.delete(path);
      }
    }
    return remaining.size === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new CliError(
      `Cannot check installed skill at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_LOCAL,
    );
  }
}

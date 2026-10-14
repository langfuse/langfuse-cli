import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";

import { CliError, EXIT_LOCAL } from "../errors";
import { skillNameSchema } from "./api";
import { decodeSkillContent } from "./local";

const MAX_FILES = 200;
const MAX_BYTES = 1_000_000;
const TEXT_EXTENSIONS = new Set((
  "md markdown mdx txt rst adoc json jsonc jsonl ndjson yaml yml toml xml csv tsv ini cfg conf properties log " +
  "html htm css scss sass less js jsx mjs cjs ts tsx py pyi sh bash zsh fish ps1 rb go rs java c h cc cpp hpp cs swift kt kts lua r pl php sql graphql gql tex"
).split(" "));

export interface LocalSkillFile {
  path: string;
  content: string;
  sha256Hash: string;
  contentLength: number;
}

export interface LocalSkill {
  name: string;
  directory: string;
  files: LocalSkillFile[];
}

async function isDirectoryWithinRoot(root: string, directory: string): Promise<boolean> {
  const physical = relative(root, await realpath(directory));
  const outsideRoot = isAbsolute(physical) || physical === ".." || physical.startsWith(`..${sep}`);
  return !outsideRoot && (await lstat(directory)).isDirectory();
}

export async function discoverSkillDirectories(directory: string): Promise<string[]> {
  const skills: string[] = [];
  const pending = [directory];

  try {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error("The skills directory must be a real directory, not a symlink");
    }
    const root = await realpath(directory);

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!(await isDirectoryWithinRoot(root, current))) {
        throw new Error(`Directory must stay inside the skills root without symlinks: ${current}`);
      }
      const entries = await readdir(current, { withFileTypes: true });

      // A skill owns its nested resources, including any additional SKILL.md files.
      if (entries.some((entry) => entry.name === "SKILL.md")) {
        skills.push(current);
        continue;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Skill discovery does not follow symlinks: ${path}`);
        }
        if (entry.isDirectory()) pending.push(path);
      }
    }
    return skills.sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot discover skills at ${directory}: ${message}`, EXIT_LOCAL);
  }
}

function validateFilePath(path: string): void {
  const invalidSegment = path.split("/").some((segment) => segment === "." || segment === "..");
  if (path.length > 512 || /[\\\x00-\x1f\x7f]/.test(path) || invalidSegment) {
    throw new Error(`Invalid skill file path: ${path}`);
  }
}

async function readSkillFile(directory: string, path: string): Promise<LocalSkillFile> {
  const filename = path.split("/").at(-1)!;
  const extension = filename.includes(".") ? filename.split(".").at(-1)!.toLowerCase() : "";
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported text file extension: ${path}`);
  }

  const handle = await open(join(directory, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES + 3) {
      throw new Error(`Skill file exceeds ${MAX_BYTES} UTF-8 bytes: ${path}`);
    }
    const bytes = await handle.readFile();
    content = decodeSkillContent(bytes);
  } finally {
    await handle.close();
  }

  if (content.includes("\0")) {
    throw new Error(`Skill file contains NUL characters: ${path}`);
  }
  return {
    path,
    content,
    contentLength: Buffer.byteLength(content),
    sha256Hash: createHash("sha256").update(content).digest("base64"),
  };
}

async function readSkillFiles(directory: string): Promise<LocalSkillFile[]> {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("The skill directory must be a real directory, not a symlink");
  }
  const root = await realpath(directory);
  const directories = [""];
  const files: LocalSkillFile[] = [];
  let totalBytes = 0;

  while (directories.length > 0) {
    const parent = directories.pop()!;
    const diskDirectory = join(directory, parent);
    if (!(await isDirectoryWithinRoot(root, diskDirectory))) {
      throw new Error(`Directory must stay inside the skill root without symlinks: ${parent}`);
    }

    for (const entry of await readdir(diskDirectory, { withFileTypes: true })) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      validateFilePath(path);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Skill files must be regular files, not symlinks: ${path}`);
      }
      if (files.length >= MAX_FILES) {
        throw new Error(`A skill must not exceed ${MAX_FILES} files`);
      }

      const file = await readSkillFile(directory, path);
      totalBytes += file.contentLength;
      if (totalBytes > MAX_BYTES) {
        throw new Error(`A skill must not exceed ${MAX_BYTES} UTF-8 bytes in total`);
      }
      files.push(file);
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function readSkillName(files: LocalSkillFile[]): string {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) {
    throw new Error("Every skill must contain a root SKILL.md file");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.content);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");
  }
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) {
    throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0].message}`);
  }
  const frontmatter: unknown = document.toJS({ maxAliasCount: 0 });
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("SKILL.md frontmatter must be an object");
  }

  const { name, description } = frontmatter as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length > 64 || !skillNameSchema.safeParse(name.trim()).success) {
    throw new Error("SKILL.md requires a lowercase skill name of at most 64 characters");
  }
  if (typeof description !== "string" || !description.trim() || description.trim().length > 1024) {
    throw new Error("SKILL.md requires a description of 1 to 1024 characters");
  }
  return name.trim();
}

export async function readLocalSkill(directory: string): Promise<LocalSkill> {
  try {
    const files = await readSkillFiles(directory);
    return { name: readSkillName(files), directory, files };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot read skill at ${directory}: ${message}`, EXIT_LOCAL);
  }
}

import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

import { compileApiContract } from "../../src/contracts/compiler";
import {
  CATALOG_PATH,
  CONFORMANCE_ROOT,
  REPOSITORY_ROOT,
  readVerifiedSpec,
  sha256,
} from "./catalog";
import {
  commandSurface,
  commandsByOperationId,
  formatGolden,
  goldenPath,
  loadGoldenSurface,
} from "./goldens";
import { compileOpenApi, type CompiledSpec } from "./openapi";
import type { Catalog, CatalogEntry } from "./types";

const README_PATH = resolve(CONFORMANCE_ROOT, "README.md");
const USER_AGENT = "langfuse-cli-conformance-suite";

export interface SpecSummary {
  version: string;
  paths: number;
  operations: number;
}

interface AddVersionOptions {
  dryRun: boolean;
  runChecks: boolean;
}

function usage(): never {
  process.stderr.write(`Usage: bun run conformance:add-version -- vX.Y.Z [--dry-run]\n`);
  process.exit(2);
}

export function normalizeReleaseTag(input: string): {
  tag: string;
  version: string;
} {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(input);
  if (!match) throw new Error(`Expected a stable release tag like v4.10.0, got ${input}`);
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  return { tag: `v${version}`, version };
}

function versionParts(version: string): [number, number, number] {
  const normalized = normalizeReleaseTag(version).version;
  return normalized.split(".").map(Number) as [number, number, number];
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function withCatalogEntry(
  catalog: Catalog,
  entry: CatalogEntry,
): Catalog {
  if (
    catalog.versions.some(
      (candidate) => candidate.version === entry.version || candidate.ref === entry.ref,
    )
  ) {
    throw new Error(`${entry.ref} is already present in the catalog`);
  }
  return {
    ...catalog,
    versions: [...catalog.versions, entry].sort((left, right) =>
      compareVersions(left.version, right.version),
    ),
  };
}

export function formatCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2).replace(
    /"knownIssues": \[\n\s+"([^"]+)"\n\s+\]/g,
    '"knownIssues": ["$1"]',
  )}\n`;
}

export function updateConformanceReadme(
  content: string,
  summaries: SpecSummary[],
): string {
  const total = summaries.reduce((sum, item) => sum + item.operations, 0);
  const updated = replaceRequired(
    content,
    /checks all \d+ operations across \d+ pinned snapshots through/,
    `checks all ${total} operations across ${summaries.length} pinned snapshots through`,
    "operation count",
  );
  const heading = "| Langfuse | Paths | Operations |";
  const tableStart = updated.indexOf(heading);
  if (tableStart === -1) throw new Error("Could not find pinned-spec table in conformance README");
  const tableEnd = updated.indexOf("\n\n", tableStart);
  if (tableEnd === -1) throw new Error("Could not find end of pinned-spec table");
  const table = [
    heading,
    "|---|---:|---:|",
    ...summaries.map(
      (summary) =>
        `| ${summary.version} | ${summary.paths} | ${summary.operations} |`,
    ),
  ].join("\n");
  return `${updated.slice(0, tableStart)}${table}${updated.slice(tableEnd)}`;
}

function replaceRequired(
  content: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${label} in conformance README`);
  }
  return content.replace(pattern, replacement);
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson(path: string): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveStableRelease(tag: string): Promise<string> {
  const release = await githubJson(
    `/repos/langfuse/langfuse/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (release.draft || release.prerelease) {
    throw new Error(`${tag} is not a stable published release`);
  }
  const ref = await githubJson(
    `/repos/langfuse/langfuse/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    object = (await githubJson(`/repos/langfuse/langfuse/git/tags/${object.sha}`))
      .object;
  }
  if (object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(object.sha)) {
    throw new Error(`Could not resolve ${tag} to an immutable commit`);
  }
  return object.sha;
}

async function downloadSpec(catalog: Catalog, commit: string): Promise<string> {
  const repository = catalog.repository.replace("https://github.com/", "");
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${catalog.specPath}`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Spec download failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function replaceConstWithEnum(value: any, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (!Array.isArray(value) && Object.hasOwn(value, "const")) {
    value.enum = [value.const];
    delete value.const;
    changed = true;
  }
  for (const child of Object.values(value)) {
    changed = replaceConstWithEnum(child, seen) || changed;
  }
  return changed;
}

async function knownIssues(raw: string): Promise<string[] | undefined> {
  const document = parse(raw, {
    maxAliasCount: 100_000,
    uniqueKeys: true,
  }) as Record<string, any>;
  try {
    await SwaggerParser.validate(structuredClone(document) as any);
    return undefined;
  } catch (originalError) {
    const patched = structuredClone(document);
    if (!replaceConstWithEnum(patched)) throw originalError;
    await SwaggerParser.validate(patched as any);
    return ["oas3.0-const-keyword"];
  }
}

async function specSummaries(
  catalog: Catalog,
  newEntry: CatalogEntry,
  newCompiled: CompiledSpec,
): Promise<SpecSummary[]> {
  return Promise.all(
    catalog.versions.map(async (entry) => {
      const compiled =
        entry.version === newEntry.version
          ? newCompiled
          : compileOpenApi(
              entry,
              await readVerifiedSpec(entry),
              commandsByOperationId(await loadGoldenSurface(entry.version)),
            );
      return {
        version: entry.version,
        paths: Object.keys(compiled.document.paths ?? {}).length,
        operations: compiled.manifest.operations.length,
      };
    }),
  );
}

async function run(command: string[], label: string): Promise<void> {
  process.stdout.write(`\n${label}\n`);
  const child = Bun.spawn(command, {
    cwd: REPOSITORY_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

async function addVersion(
  input: string,
  options: AddVersionOptions,
): Promise<void> {
  const { tag, version } = normalizeReleaseTag(input);
  const originalCatalogText = await Bun.file(CATALOG_PATH).text();
  const originalReadme = await Bun.file(README_PATH).text();
  const catalog = JSON.parse(originalCatalogText) as Catalog;
  if (catalog.versions.some((entry) => entry.version === version)) {
    throw new Error(`${tag} is already bundled`);
  }

  process.stdout.write(`Resolving ${tag}\n`);
  const commit = await resolveStableRelease(tag);
  const raw = await downloadSpec(catalog, commit);
  const issues = await knownIssues(raw);
  const entry: CatalogEntry = {
    version,
    ref: tag,
    commit,
    sha256: await sha256(raw),
    ...(issues ? { knownIssues: issues } : {}),
  };
  const contract = compileApiContract(entry, raw);
  const surface = commandSurface(contract.operations);
  const newCommands = commandsByOperationId(surface);
  const compiled = compileOpenApi(entry, raw, newCommands);
  if (compiled.unsupported.length > 0) {
    throw new Error(`Unsupported OpenAPI features: ${compiled.unsupported.join(", ")}`);
  }
  const updatedCatalog = withCatalogEntry(catalog, entry);
  const summaries = await specSummaries(updatedCatalog, entry, compiled);
  const updatedReadme = updateConformanceReadme(originalReadme, summaries);
  process.stdout.write(
    `${tag} -> ${commit}\nSHA-256 ${entry.sha256}\n${compiled.manifest.operations.length} operations\n`,
  );
  if (options.dryRun) {
    process.stdout.write("Dry run complete; no files changed\n");
    return;
  }

  const path = resolve(CONFORMANCE_ROOT, "specs", version, "openapi.yml");
  if (await Bun.file(path).exists()) {
    throw new Error(`${path} already exists but ${tag} is not cataloged`);
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await Bun.write(path, raw);
    await Bun.write(goldenPath(version), formatGolden(surface));
    await Bun.write(CATALOG_PATH, formatCatalog(updatedCatalog));
    await Bun.write(README_PATH, updatedReadme);
    if (options.runChecks) {
      await run(["bun", "run", "typecheck"], "Typecheck");
      await run(["bun", "test"], "Test suite");
      await run(["bun", "run", "build"], "Build contracts");
      await run(
        [
          "bun",
          "run",
          "conformance:run",
          "--",
          "--version",
          version,
          "--",
          "bun",
          "bin/langfuse.mjs",
          "--api-version",
          version,
        ],
        `Conformance ${version}`,
      );
    }
  } catch (error) {
    await Bun.write(CATALOG_PATH, originalCatalogText);
    await Bun.write(README_PATH, originalReadme);
    await rm(resolve(CONFORMANCE_ROOT, "specs", version), {
      recursive: true,
      force: true,
    });
    await rm(goldenPath(version), { force: true });
    throw error;
  }
  process.stdout.write(`\nAdded ${tag}. Review and live-test changed endpoints before commit.\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith("--"));
  if (!input || args.some((arg) => ![input, "--dry-run"].includes(arg))) usage();
  await addVersion(input, {
    dryRun: args.includes("--dry-run"),
    runChecks: true,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

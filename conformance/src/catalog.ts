import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Catalog, CatalogEntry } from "./types";

export const CONFORMANCE_ROOT = resolve(import.meta.dir, "..");
export const REPOSITORY_ROOT = resolve(CONFORMANCE_ROOT, "..");
export const CATALOG_PATH = resolve(CONFORMANCE_ROOT, "catalog.json");

export async function loadCatalog(): Promise<Catalog> {
  const catalog = (await Bun.file(CATALOG_PATH).json()) as Catalog;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.versions)) {
    throw new Error(`Unsupported catalog at ${CATALOG_PATH}`);
  }
  return catalog;
}

export function specPath(entry: CatalogEntry): string {
  return resolve(CONFORMANCE_ROOT, "specs", entry.version, "openapi.yml");
}

export function rawSpecUrl(catalog: Catalog, entry: CatalogEntry): string {
  return `${catalog.repository.replace("github.com", "raw.githubusercontent.com")}/${entry.commit}/${catalog.specPath}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readVerifiedSpec(entry: CatalogEntry): Promise<string> {
  const path = specPath(entry);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Missing ${path}; run bun run conformance:sync`);
  }
  const text = await file.text();
  const actual = await sha256(text);
  if (actual !== entry.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${entry.ref}: expected ${entry.sha256}, got ${actual}`,
    );
  }
  return text;
}

export async function syncSpecs(entries?: CatalogEntry[]): Promise<void> {
  const catalog = await loadCatalog();
  const selected = entries ?? catalog.versions;
  for (const entry of selected) {
    const url = rawSpecUrl(catalog, entry);
    const response = await fetch(url, {
      headers: { "user-agent": "langfuse-cli-conformance-suite" },
    });
    if (!response.ok) {
      throw new Error(`${entry.ref}: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    const actual = await sha256(text);
    const expectedUpstream = entry.upstreamSha256 ?? entry.sha256;
    if (actual !== expectedUpstream) {
      throw new Error(
        `${entry.ref}: upstream bytes changed; expected ${expectedUpstream}, got ${actual}`,
      );
    }
    const path = specPath(entry);
    if (entry.modifications?.length) {
      await readVerifiedSpec(entry);
      process.stdout.write(
        `verified ${entry.ref} (${entry.modifications.join(", ")})\n`,
      );
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    if (!(await Bun.file(path).exists()) || (await Bun.file(path).text()) !== text) {
      await Bun.write(path, text);
      process.stdout.write(`synced ${entry.ref} -> ${path}\n`);
    } else {
      process.stdout.write(`verified ${entry.ref}\n`);
    }
  }
}

export function selectEntries(
  catalog: Catalog,
  versions: string[],
): CatalogEntry[] {
  if (versions.length === 0) return catalog.versions;
  return versions.map((version) => {
    const entry = catalog.versions.find(
      (candidate) =>
        candidate.version === version || candidate.ref === version,
    );
    if (!entry) throw new Error(`Unknown catalog version: ${version}`);
    return entry;
  });
}

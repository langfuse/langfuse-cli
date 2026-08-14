import { readFile } from "node:fs/promises";

import type {
  ApiContract,
  ApiContractCatalog,
  ApiContractCatalogEntry,
} from "./types";

const CATALOG_URL = new URL("./contracts/catalog.json", import.meta.url);

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requestedMajor(version: string): number | undefined {
  const match = /^v?(\d+)(?:\.x)?$/i.exec(version);
  return match ? Number(match[1]) : undefined;
}

function latestMajorEntry(
  entries: ApiContractCatalogEntry[],
  major: number,
): ApiContractCatalogEntry | undefined {
  return [...entries]
    .filter((entry) => parseVersion(entry.version)?.[0] === major)
    .sort((left, right) => compareVersion(right.version, left.version))[0];
}

export async function loadContractCatalog(): Promise<ApiContractCatalog> {
  const catalog = JSON.parse(
    await readFile(CATALOG_URL, "utf8"),
  ) as ApiContractCatalog;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.versions)) {
    throw new Error("Invalid bundled API contract catalog");
  }
  return catalog;
}

async function detectServerVersion(host: string, timeoutMs: number): Promise<string> {
  const response = await fetch(`${host}/api/public/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`API version detection failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !parseVersion(body.version)) {
    throw new Error("API version detection returned no semantic version");
  }
  return body.version.replace(/^v/, "");
}

function compatibleEntry(
  entries: ApiContractCatalogEntry[],
  serverVersion: string,
): ApiContractCatalogEntry | undefined {
  const target = parseVersion(serverVersion);
  if (!target) return undefined;
  return [...entries]
    .filter((entry) => {
      const version = parseVersion(entry.version);
      return version?.[0] === target[0] && compareVersion(entry.version, serverVersion) <= 0;
    })
    .sort((left, right) => compareVersion(right.version, left.version))[0];
}

export async function resolveContractVersion(params: {
  requested?: string;
  host: string;
  timeoutMs: number;
  catalog?: ApiContractCatalog;
}): Promise<{ catalog: ApiContractCatalog; version: string; detected?: string }> {
  const catalog = params.catalog ?? (await loadContractCatalog());
  const requested = params.requested ?? "latest";
  if (requested === "latest") {
    return { catalog, version: catalog.latest };
  }
  if (requested === "auto") {
    const detected = await detectServerVersion(params.host, params.timeoutMs);
    const exact = catalog.versions.find((entry) => entry.version === detected);
    const compatible = exact ?? compatibleEntry(catalog.versions, detected);
    if (!compatible) {
      throw new Error(
        `No bundled API contract is compatible with detected server ${detected}`,
      );
    }
    return { catalog, version: compatible.version, detected };
  }
  const exact = catalog.versions.find((entry) => entry.version === requested);
  if (exact) return { catalog, version: exact.version };
  const major = requestedMajor(requested);
  if (major !== undefined) {
    const latestInMajor = latestMajorEntry(catalog.versions, major);
    if (latestInMajor) return { catalog, version: latestInMajor.version };
    const availableMajors = [
      ...new Set(
        catalog.versions
          .map((entry) => parseVersion(entry.version)?.[0])
          .filter((value): value is number => value !== undefined),
      ),
    ].sort((left, right) => left - right);
    throw new Error(
      `No bundled API contract for major version ${major}. Available majors: ${availableMajors.join(", ")}`,
    );
  }
  throw new Error(
    `Unknown API version ${requested}. Available: ${catalog.versions
      .map((entry) => entry.version)
      .join(", ")}`,
  );
}

export async function loadApiContract(version: string): Promise<ApiContract> {
  const url = new URL(`./contracts/${encodeURIComponent(version)}.json`, import.meta.url);
  const contract = JSON.parse(await readFile(url, "utf8")) as ApiContract;
  if (contract.schemaVersion !== 1 || contract.apiVersion !== version) {
    throw new Error(`Invalid bundled API contract for ${version}`);
  }
  return contract;
}

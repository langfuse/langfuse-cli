import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { CONFORMANCE_ROOT } from "./catalog";
import { sameJson } from "./capture";
import type { CommandAlias, CommandName } from "./types";

export interface GoldenCommand {
  operationId: string;
  key: string;
  resource: string;
  action: string;
  aliases?: CommandAlias[];
  deprecated?: true;
}

interface NamedOperation {
  operationId: string;
  key: string;
  command: CommandName;
  deprecated?: true;
}

export const GOLDENS_DIRECTORY = resolve(CONFORMANCE_ROOT, "goldens");

export function goldenPath(version: string): string {
  return resolve(GOLDENS_DIRECTORY, `${version}.json`);
}

export async function goldenFiles(): Promise<string[]> {
  return (await readdir(GOLDENS_DIRECTORY)).sort(byCodepoint);
}

// Committed artifacts must not depend on the contributor machine's ICU
// locale, so goldens are ordered by codepoint, never by localeCompare.
function byCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function commandSurface(operations: NamedOperation[]): GoldenCommand[] {
  return [...operations]
    .sort((left, right) => byCodepoint(left.operationId, right.operationId))
    .map((operation) => ({
      operationId: operation.operationId,
      key: operation.key,
      resource: operation.command.resource,
      action: operation.command.action,
      ...(operation.command.aliases?.length
        ? { aliases: operation.command.aliases }
        : {}),
      ...(operation.deprecated ? { deprecated: true as const } : {}),
    }));
}

export function formatGolden(surface: GoldenCommand[]): string {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

export function commandsByOperationId(
  surface: GoldenCommand[],
): Record<string, CommandName> {
  return Object.fromEntries(
    surface.map((entry) => [
      entry.operationId,
      {
        resource: entry.resource,
        action: entry.action,
        ...(entry.aliases ? { aliases: entry.aliases } : {}),
      },
    ]),
  );
}

function assertGoldenEntry(path: string, index: number, entry: any): void {
  const context = `${path} entry ${index}`;
  for (const field of ["operationId", "key", "resource", "action"] as const) {
    if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
      throw new Error(`${context}: missing or invalid "${field}"`);
    }
  }
  if (entry.aliases !== undefined) {
    if (!Array.isArray(entry.aliases) || entry.aliases.length === 0) {
      throw new Error(`${context}: "aliases" must be a non-empty array`);
    }
    for (const alias of entry.aliases) {
      if (
        typeof alias?.resource !== "string" ||
        typeof alias?.action !== "string" ||
        !["path", "tag", "version"].includes(alias?.source)
      ) {
        throw new Error(`${context}: invalid alias ${JSON.stringify(alias)}`);
      }
    }
  }
  if (entry.deprecated !== undefined && entry.deprecated !== true) {
    throw new Error(`${context}: "deprecated" must be true when present`);
  }
}

// Returns the committed golden as-is (validated, never re-sorted or
// repaired): the byte-level pin is part of the contract.
export async function loadGoldenSurface(version: string): Promise<GoldenCommand[]> {
  const path = goldenPath(version);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Missing command golden ${path}; run bun run goldens:update and review the diff`,
    );
  }
  const parsed = (await file.json()) as GoldenCommand[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid command golden at ${path}`);
  }
  parsed.forEach((entry, index) => assertGoldenEntry(path, index, entry));
  return parsed;
}

// Shared golden gate: the goldens test and the build must apply exactly the
// same comparison. Returns human-readable differences, empty when identical.
export async function goldenSurfaceDiff(
  version: string,
  operations: NamedOperation[],
): Promise<string[]> {
  const golden = await loadGoldenSurface(version);
  const compiled = commandSurface(operations);
  const differences: string[] = [];
  const goldenIds = golden.map((entry) => entry.operationId);
  const sortedIds = [...goldenIds].sort(byCodepoint);
  if (goldenIds.join("\n") !== sortedIds.join("\n")) {
    differences.push(
      `${version}: golden is not in canonical order; run bun run goldens:update`,
    );
  }
  const goldenById = new Map(golden.map((entry) => [entry.operationId, entry]));
  const compiledById = new Map(
    compiled.map((entry) => [entry.operationId, entry]),
  );
  for (const [operationId, entry] of compiledById) {
    const pinned = goldenById.get(operationId);
    if (!pinned) {
      differences.push(`${version}: ${operationId} is compiled but not pinned`);
    } else if (!sameJson(pinned, entry)) {
      differences.push(
        `${version}: ${operationId} differs; golden ${JSON.stringify(pinned)} vs compiled ${JSON.stringify(entry)}`,
      );
    }
  }
  for (const operationId of goldenById.keys()) {
    if (!compiledById.has(operationId)) {
      differences.push(`${version}: ${operationId} is pinned but not compiled`);
    }
  }
  return differences;
}

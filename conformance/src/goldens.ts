import { resolve } from "node:path";

import { CONFORMANCE_ROOT } from "./catalog";
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

export function goldenPath(version: string): string {
  return resolve(CONFORMANCE_ROOT, "goldens", `${version}.json`);
}

export function commandSurface(operations: NamedOperation[]): GoldenCommand[] {
  return [...operations]
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
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
  return commandSurface(
    parsed.map((entry) => ({
      operationId: entry.operationId,
      key: entry.key,
      command: {
        resource: entry.resource,
        action: entry.action,
        ...(entry.aliases ? { aliases: entry.aliases } : {}),
      },
      ...(entry.deprecated ? { deprecated: true as const } : {}),
    })),
  );
}

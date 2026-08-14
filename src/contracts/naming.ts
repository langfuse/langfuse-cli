import type { CommandAlias, CommandName, HttpMethod } from "./types";

interface NamingInput {
  operationId?: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  deprecated?: true;
}

interface RouteName {
  resource: string;
  version?: string;
  tail: string[];
}

interface PlannedName {
  input: NamingInput;
  route: RouteName;
  baseAction: string;
  resource: string;
  action: string;
  aliases: CommandAlias[];
  index: number;
}

const IRREGULAR: Record<string, string> = {
  person: "people",
  man: "men",
  woman: "women",
  child: "children",
  tooth: "teeth",
  foot: "feet",
  mouse: "mice",
  goose: "geese",
};
const UNCOUNTABLE = new Set([
  "metadata",
  "information",
  "equipment",
  "money",
  "series",
  "species",
]);
const API_VERSION = /^v\d+$/i;

export function kebabCase(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_.:/]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function pluralize(input: string): string {
  const word = input.trim().toLowerCase();
  if (!word || UNCOUNTABLE.has(word)) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (word.endsWith("s")) return word;
  if (/[bcdfghjklmnpqrstvwxyz]y$/.test(word)) {
    return word.replace(/y$/, "ies");
  }
  if (/(ch|sh|x|z)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function singularize(input: string): string {
  if (input.endsWith("ies")) return `${input.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/.test(input)) return input.slice(0, -2);
  if (input.endsWith("s") && !input.endsWith("ss")) return input.slice(0, -1);
  return input;
}

function isParameter(segment: string | undefined): boolean {
  return Boolean(segment?.startsWith("{") && segment.endsWith("}"));
}

function routeName(path: string): RouteName {
  const all = path.split("/").filter(Boolean);
  const publicIndex = all.lastIndexOf("public");
  const segments = all.slice(publicIndex === -1 ? 0 : publicIndex + 1);
  let version: string | undefined;
  if (API_VERSION.test(segments[0] ?? "")) version = segments.shift()!.toLowerCase();
  while (isParameter(segments[0])) segments.shift();
  if (segments.length === 0) return { resource: "api", ...(version ? { version } : {}), tail: [] };

  let resource = kebabCase(segments.shift()!);
  if (resource === "unstable" && segments[0] && !isParameter(segments[0])) {
    resource = `${resource}-${kebabCase(segments.shift()!)}`;
  }
  if (resource === "otel" && API_VERSION.test(segments[0] ?? "")) {
    version ??= segments.shift()!.toLowerCase();
  }
  return { resource, ...(version ? { version } : {}), tail: segments };
}

function operationSuffix(operationId = ""): string {
  const splitAt = Math.max(
    operationId.lastIndexOf("__"),
    operationId.lastIndexOf("_"),
    operationId.lastIndexOf("."),
  );
  const suffix = splitAt === -1 ? operationId : operationId.slice(splitAt + 1);
  return kebabCase(suffix).replace(/-v\d+$/i, "");
}

function restAction(input: NamingInput, route: RouteName, suffix: string): string {
  const tail = route.tail.filter((segment) => !API_VERSION.test(segment));
  const staticTail = tail.filter((segment) => !isParameter(segment));
  const subject = kebabCase(staticTail.at(-1) ?? "");
  const singularSubject = singularize(subject);
  const item = isParameter(tail.at(-1));

  if (staticTail.length === 0) {
    if (input.method === "GET") {
      if (item) return "get";
      if (["health", "metrics"].includes(suffix)) return "get";
      return "list";
    }
    if (input.method === "POST") return "create";
    if (["PUT", "PATCH"].includes(input.method)) return "update";
    if (input.method === "DELETE") return item ? "delete" : "delete-many";
    return kebabCase(input.method);
  }

  if (input.method === "GET") {
    if (item) return `get-${singularSubject}`;
    const suffixSubject = suffix.split("-").at(-1) ?? "";
    const explicitSingleton = suffix.startsWith("get-") && !suffixSubject.endsWith("s");
    return `${explicitSingleton ? "get" : "list"}-${subject}`;
  }
  if (input.method === "POST") {
    return `${suffix.startsWith("add-") ? "add" : "create"}-${singularSubject}`;
  }
  if (["PUT", "PATCH"].includes(input.method)) {
    return `${suffix.startsWith("upsert-") ? "upsert" : "update"}-${singularSubject}`;
  }
  if (input.method === "DELETE") return `delete-${singularSubject}`;
  return `${kebabCase(input.method)}-${singularSubject}`;
}

function inferAction(input: NamingInput, route: RouteName): string {
  const suffix = operationSuffix(input.operationId);
  if (["batch", "submit", "upsert"].includes(suffix)) return suffix;
  if (suffix === "delete-multiple") return "delete-many";
  if (suffix.startsWith("add-") || suffix.startsWith("export-")) return suffix;
  if (suffix.startsWith("get-") && input.method !== "GET") return suffix;
  if (suffix.endsWith("-status")) return suffix;
  return restAction(input, route, suffix);
}

function versionRank(version?: string): number {
  return version ? Number(version.slice(1)) : 0;
}

function commandKey(resource: string, action: string): string {
  return `${resource}\u0000${action}`;
}

function tagResources(input: NamingInput): string[] {
  return input.tags
    .map((tag) => kebabCase(tag))
    .filter((tag) => tag && !["default", "defaults", "api"].includes(tag));
}

function uniqueFallbackAction(plan: PlannedName, used: Set<string>): string {
  const suffix = operationSuffix(plan.input.operationId) || kebabCase(plan.input.method);
  let candidate = suffix === plan.action ? `${plan.action}-${plan.index + 1}` : suffix;
  let index = 2;
  while (used.has(commandKey(plan.resource, candidate))) {
    candidate = `${suffix}-${index++}`;
  }
  return candidate;
}

export function planCommandNames(inputs: NamingInput[]): CommandName[] {
  const planned: PlannedName[] = inputs.map((input, index) => {
    const route = routeName(input.path);
    const baseAction = inferAction(input, route);
    const resource = input.deprecated
      ? route.version
        ? `${route.resource}-${route.version}`
        : `legacy-${route.resource}`
      : route.resource;
    return {
      input,
      route,
      baseAction,
      resource,
      action: baseAction,
      aliases: [],
      index,
    };
  });

  const activeGroups = new Map<string, PlannedName[]>();
  for (const plan of planned.filter((candidate) => !candidate.input.deprecated)) {
    const key = commandKey(plan.route.resource, plan.baseAction);
    const group = activeGroups.get(key) ?? [];
    group.push(plan);
    activeGroups.set(key, group);
  }
  for (const group of activeGroups.values()) {
    group.sort((left, right) => {
      const versionDifference = versionRank(right.route.version) - versionRank(left.route.version);
      return versionDifference || left.index - right.index;
    });
    for (const loser of group.slice(1)) {
      if (loser.route.version) loser.resource = `${loser.route.resource}-${loser.route.version}`;
    }
  }

  const usedCanonical = new Set<string>();
  for (const plan of planned) {
    let key = commandKey(plan.resource, plan.action);
    if (usedCanonical.has(key)) {
      plan.action = uniqueFallbackAction(plan, usedCanonical);
      key = commandKey(plan.resource, plan.action);
    }
    usedCanonical.add(key);
  }

  const claimedAliases = new Set<string>();
  for (const plan of planned) {
    const candidates: CommandAlias[] = [];
    if (plan.resource !== plan.route.resource) {
      candidates.push({
        resource: plan.route.resource,
        action: plan.baseAction,
        source: "path",
      });
    }
    if (plan.route.version) {
      candidates.push({
        resource: `${plan.route.resource}-${plan.route.version}`,
        action: plan.baseAction,
        source: "version",
      });
    }
    for (const resource of tagResources(plan.input)) {
      candidates.push({ resource, action: plan.baseAction, source: "tag" });
    }

    for (const alias of candidates) {
      const key = commandKey(alias.resource, alias.action);
      if (
        key === commandKey(plan.resource, plan.action) ||
        usedCanonical.has(key) ||
        claimedAliases.has(key)
      ) {
        continue;
      }
      claimedAliases.add(key);
      plan.aliases.push(alias);
    }
  }

  return planned.map((plan) => ({
    resource: plan.resource,
    action: plan.action,
    ...(plan.aliases.length ? { aliases: plan.aliases } : {}),
  }));
}

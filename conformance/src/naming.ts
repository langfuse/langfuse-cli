import type { CommandName, HttpMethod } from "./types";

interface NamingInput {
  operationId?: string;
  method: HttpMethod;
  path: string;
  tags: string[];
}

interface PlannedNaming extends NamingInput, CommandName {}

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

function pathArgs(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function operationIdParts(operationId = ""): {
  prefix?: string;
  suffix?: string;
} {
  const separator = operationId.includes(".")
    ? "."
    : operationId.includes("__")
      ? "__"
      : operationId.includes("_")
        ? "_"
        : undefined;
  if (!separator) return operationId ? { suffix: operationId } : {};
  const [prefix, ...rest] = operationId.split(separator);
  return { prefix, suffix: rest.join(separator) };
}

function canonicalAction(input: string): string {
  const action = kebabCase(input);
  if (["retrieve", "read"].includes(action)) return "get";
  if (["search"].includes(action)) return "list";
  if (action === "patch") return "update";
  if (action === "remove") return "delete";
  return action;
}

function inferResource(input: NamingInput): string {
  const tag = input.tags[0]?.trim();
  if (tag && !["default", "defaults", "api"].includes(tag.toLowerCase())) {
    return pluralize(kebabCase(tag));
  }
  const prefix = operationIdParts(input.operationId).prefix;
  if (prefix) return pluralize(kebabCase(prefix));
  const segment = input.path.split("/").filter(Boolean)[0] ?? "api";
  return pluralize(kebabCase(segment.replace(/^\{.+\}$/, "") || "api"));
}

function inferAction(input: NamingInput): string {
  const suffix = operationIdParts(input.operationId).suffix;
  if (suffix) {
    const action = canonicalAction(suffix);
    if (["get", "list", "create", "update", "delete"].includes(action)) {
      return action;
    }
  }
  const hasPathArg = pathArgs(input.path).length > 0;
  if (input.method === "GET") return hasPathArg ? "get" : "list";
  if (input.method === "POST" && !hasPathArg) return "create";
  if (["PUT", "PATCH"].includes(input.method) && hasPathArg) return "update";
  if (input.method === "DELETE" && hasPathArg) return "delete";
  return kebabCase(input.method);
}

function disambiguator(operation: PlannedNaming, index: number): string {
  let name = kebabCase(operation.operationId ?? "");
  const synonyms: Record<string, string[]> = {
    get: ["get", "retrieve", "read", "list", "search"],
    list: ["list", "search", "get"],
    create: ["create", "post"],
    update: ["update", "patch", "put"],
    delete: ["delete", "remove"],
  };
  for (const synonym of synonyms[operation.action] ?? [operation.action]) {
    if (name.startsWith(`${synonym}-`)) {
      name = name.slice(synonym.length + 1);
      break;
    }
  }
  const singular = operation.resource.replace(/s$/, "");
  for (const resource of [operation.resource, singular]) {
    if (name.startsWith(`${resource}-`)) name = name.slice(resource.length + 1);
    else if (name.includes(`-${resource}-`)) {
      name = name.replace(`-${resource}-`, "-");
    } else if (name.endsWith(`-${resource}`)) {
      name = name.slice(0, -(resource.length + 1));
    }
  }
  if (name && name !== operation.action && name !== operation.resource) {
    return `${operation.action}-${name}`;
  }
  const segments = operation.path.split("/").filter(Boolean).reverse();
  for (const segment of segments) {
    if (segment.startsWith("{")) continue;
    const candidate = kebabCase(segment);
    if (![operation.resource, singular].includes(candidate)) {
      return `${operation.action}-${candidate}`;
    }
  }
  return `${operation.action}-${index}`;
}

export function planCommandNames(inputs: NamingInput[]): CommandName[] {
  const planned: PlannedNaming[] = inputs.map((input) => {
    const action = inferAction(input);
    return {
      ...input,
      resource: inferResource(input),
      action,
      canonicalAction: action,
    };
  });
  const totals = new Map<string, number>();
  for (const operation of planned) {
    const key = `${operation.resource}:${operation.action}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return planned.map((operation) => {
    const key = `${operation.resource}:${operation.action}`;
    if ((totals.get(key) ?? 0) === 1) {
      return {
        resource: operation.resource,
        action: operation.action,
        canonicalAction: operation.canonicalAction,
      };
    }
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    return {
      resource: operation.resource,
      action: disambiguator(operation, index),
      canonicalAction: operation.canonicalAction,
      aliasOf: `${operation.resource} ${operation.canonicalAction}`,
    };
  });
}

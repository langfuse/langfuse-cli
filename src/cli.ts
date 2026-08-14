import { readFile, writeFile } from "node:fs/promises";
import { text as streamText } from "node:stream/consumers";

import packageJson from "../package.json";

import { createApiClient, renderCurl } from "./client";
import {
  loadApiContract,
  loadContractCatalog,
  resolveContractVersion,
} from "./contracts/loader";
import type {
  ApiBodyField,
  ApiCallInput,
  ApiContract,
  ApiContractCatalog,
  ApiOperation,
  ApiParameter,
  ApiResult,
  JsonValue,
  ValueKind,
} from "./contracts/types";

const DEFAULT_HOST = "https://cloud.langfuse.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const LANGFUSE_SKILL_URL =
  "https://raw.githubusercontent.com/langfuse/skills/main/skills/langfuse/SKILL.md";
const GET_SKILL_FETCH_TIMEOUT_MS = 5_000;
const VALUE_FLAGS = new Set([
  "--public-key",
  "--secret-key",
  "--host",
  "--env",
  "--api-version",
  "--timeout",
  "--output",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--curl", "--show-secrets"]);

interface ParsedGlobals {
  values: Record<string, string>;
  booleans: Set<string>;
  args: string[];
}

interface RuntimeConfig {
  publicKey?: string;
  secretKey?: string;
  host: string;
  apiVersion?: string;
  timeoutMs: number;
  json: boolean;
  curl: boolean;
  showSecrets: boolean;
  output?: string;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

function flagKey(flag: string): string {
  return flag.replace(/^--/, "");
}

function extractGlobals(args: string[]): ParsedGlobals {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
      if (value === undefined || (equals === -1 && value.startsWith("--"))) {
        throw new CliError(`${name} requires a value`);
      }
      values[flagKey(name)] = value;
      if (equals === -1) index++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(flagKey(name));
      continue;
    }
    remaining.push(token);
  }
  return { values, booleans, args: remaining };
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function runtimeConfig(globals: ParsedGlobals): Promise<RuntimeConfig> {
  const fileEnv = globals.values.env
    ? parseEnv(await readFile(globals.values.env, "utf8"))
    : {};
  const env = { ...process.env, ...fileEnv };
  const timeoutMs = Number(globals.values.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError("--timeout must be a positive number of milliseconds");
  }
  return {
    publicKey: globals.values["public-key"] ?? env.LANGFUSE_PUBLIC_KEY,
    secretKey: globals.values["secret-key"] ?? env.LANGFUSE_SECRET_KEY,
    host: (
      globals.values.host ??
      env.LANGFUSE_BASE_URL ??
      env.LANGFUSE_HOST ??
      DEFAULT_HOST
    ).replace(/\/+$/, ""),
    apiVersion: globals.values["api-version"] ?? env.LANGFUSE_API_VERSION,
    timeoutMs,
    json: globals.booleans.has("json"),
    curl: globals.booleans.has("curl"),
    showSecrets: globals.booleans.has("show-secrets"),
    output: globals.values.output,
  };
}

async function fetchText(
  url: string,
  label: string,
  timeoutMs?: number,
): Promise<string> {
  const response = await fetch(url, {
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${label} from ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

async function getSkill(): Promise<void> {
  try {
    process.stdout.write(
      await fetchText(LANGFUSE_SKILL_URL, "skill", GET_SKILL_FETCH_TIMEOUT_MS),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to fetch the latest Langfuse skill from GitHub.
This environment may block direct GitHub access.

Download the skill manually from:
  ${LANGFUSE_SKILL_URL}

Then add the downloaded SKILL.md to your agent context manually.

Original error: ${reason}
`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(`langfuse-cli — Interact with Langfuse from the command line

Usage: langfuse [options] <command>

Commands:
  api                     Interact with the Langfuse REST API
  get-skill               Print the latest Langfuse skill from GitHub

Options:
  --public-key <key>      Langfuse public key (or LANGFUSE_PUBLIC_KEY)
  --secret-key <key>      Langfuse secret key (or LANGFUSE_SECRET_KEY)
  --host <url>            Langfuse host (default: ${DEFAULT_HOST})
  --env <path>            Load env vars from a file
  --api-version <version> Exact/major version, latest, or auto
  --timeout <ms>          Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help              Show help
  --version               Show CLI version

Examples:
  langfuse api help
  langfuse api prompts list
  langfuse api prompts create --body-json '{"name":"my-prompt","type":"text","prompt":"Hello"}'
  langfuse api observations list --limit 20
`);
}

interface CommandBinding {
  operation: ApiOperation;
  action: string;
  alias: boolean;
}

function canonicalResourceMap(contract: ApiContract): Map<string, ApiOperation[]> {
  const resources = new Map<string, ApiOperation[]>();
  for (const operation of contract.operations) {
    const existing = resources.get(operation.command.resource) ?? [];
    existing.push(operation);
    resources.set(operation.command.resource, existing);
  }
  for (const operations of resources.values()) {
    operations.sort((left, right) =>
      left.command.action.localeCompare(right.command.action),
    );
  }
  return resources;
}

function resourceMap(contract: ApiContract): Map<string, CommandBinding[]> {
  const resources = new Map<string, CommandBinding[]>();
  const add = (resource: string, binding: CommandBinding) => {
    const existing = resources.get(resource) ?? [];
    existing.push(binding);
    resources.set(resource, existing);
  };
  for (const operation of contract.operations) {
    add(operation.command.resource, {
      operation,
      action: operation.command.action,
      alias: false,
    });
    for (const alias of operation.command.aliases ?? []) {
      add(alias.resource, { operation, action: alias.action, alias: true });
    }
  }
  for (const bindings of resources.values()) {
    bindings.sort((left, right) => left.action.localeCompare(right.action));
  }
  return resources;
}

function printApiHelp(contract: ApiContract): void {
  const resources = [...canonicalResourceMap(contract)].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  process.stdout.write(`Usage: langfuse api <resource> <action> [options]

API snapshot: ${contract.apiVersion}

Resources:
${resources
  .map(
    ([resource, operations]) =>
      `  ${resource}${operations.some((operation) => operation.deprecated) ? " [contains deprecated actions]" : ""}`,
  )
  .join("\n")}

Discovery:
  api help [resource] [action]
  api schema --json          Machine-readable command schema
  api __schema --json        Legacy command alias
  api versions list          Bundled historical snapshots
  Path commands are canonical; OpenAPI tag and route-version aliases also work

Action options:
  --body-json <json>         Lossless JSON request body
  --body-file <path|->       Read JSON body from file or stdin
  --json                     Stable JSON response envelope
  --curl                     Print curl without executing
`);
}

function printResourceHelp(contract: ApiContract, resource: string): void {
  const bindings = resourceMap(contract).get(resource);
  if (!bindings) throw new CliError(`Unknown API resource: ${resource}`);
  process.stdout.write(`Usage: langfuse api ${resource} <action> [options]

Actions:
${bindings
  .map(
    (binding) => {
      const label = `${binding.action}${binding.alias ? " [alias]" : ""}${binding.operation.deprecated ? " [deprecated]" : ""}`;
      return `  ${label.padEnd(43)} ${binding.operation.method} ${binding.operation.path}`;
    },
  )
  .join("\n")}
`);
}

function explicitDeprecationNote(operation: ApiOperation): string | undefined {
  const description = operation.description?.trim();
  if (!description || !/^(?:\*\*)?deprecated\b/i.test(description)) {
    return undefined;
  }
  return description
    .split(/\n\s*\n/, 1)[0]
    .replace(/^\*\*Deprecated\.\*\*\s*/i, "")
    .replace(/^Deprecated\.?\s*/i, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function assertOperationCallable(
  operation: ApiOperation,
  apiVersion: string,
): void {
  if (!operation.deprecated) return;
  const note = explicitDeprecationNote(operation);
  throw new CliError(
    `Cannot call deprecated API operation "${operation.command.resource} ${operation.command.action}" (${operation.method} ${operation.path}) in API ${apiVersion}.` +
      (note ? ` ${note}` : " No replacement is declared in its OpenAPI description.") +
      ` Use "langfuse api help ${operation.command.resource}" or "langfuse api schema --json" to find supported operations.`,
  );
}

function kindLabel(kind: ValueKind): string {
  return kind === "array" ? "value (repeatable)" : kind;
}

function flagUsage(name: string, kind: ValueKind): string {
  return kind === "boolean"
    ? `--${name}[=true|false] / --no-${name}`
    : `--${name} <${kindLabel(kind)}>`;
}

function printOperationHelp(operation: ApiOperation): void {
  const positionals = operation.pathParameterOrder
    .map((name) => `<${name}>`)
    .join(" ");
  const lines: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location === "path") continue;
    lines.push(
      `  ${flagUsage(parameter.cliName, parameter.kind)}${parameter.required ? " (required)" : ""}`,
    );
  }
  if (operation.requestBody?.legacyFieldFlags) {
    for (const field of operation.requestBody.fields) {
      lines.push(
        `  ${flagUsage(field.name, field.kind)}${field.required ? " (required)" : ""}`,
      );
    }
  }
  if (operation.requestBody) {
    lines.push("  --body-json <json>             Lossless JSON body");
    lines.push("  --body-file <path|->          JSON body from file or stdin");
  }
  process.stdout.write(`Usage: langfuse api ${operation.command.resource} ${operation.command.action}${positionals ? ` ${positionals}` : ""} [options]

${operation.summary ?? operation.operationId}
${operation.description ? `\n${operation.description}\n` : ""}
${
  operation.deprecated
    ? `\nDEPRECATED\nThis operation is discoverable but cannot be called by this CLI.${explicitDeprecationNote(operation) ? ` ${explicitDeprecationNote(operation)}` : ""}\n`
    : ""
}
Options:
${lines.length ? lines.join("\n") : "  (no operation-specific options)"}
  --json                         JSON response envelope
  --curl                         Print curl without executing
`);
}

export function operationByCommand(
  contract: ApiContract,
  resource: string,
  action: string,
): ApiOperation {
  const operation = contract.operations.find(
    (candidate) => {
      if (
        candidate.command.resource === resource &&
        candidate.command.action === action
      ) {
        return true;
      }
      return candidate.command.aliases?.some(
        (alias) => alias.resource === resource && alias.action === action,
      );
    },
  );
  if (!operation) {
    if (!resourceMap(contract).has(resource)) {
      throw new CliError(`Unknown API resource: ${resource}`);
    }
    throw new CliError(`Unknown action ${resource} ${action}`);
  }
  return operation;
}

function parseJsonValue(value: string, kind?: ValueKind): JsonValue {
  if (kind === "string") return value;
  if (kind === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new CliError(`Expected boolean, got ${value}`);
  }
  if (kind === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new CliError(`Expected number, got ${value}`);
    return number;
  }
  if (kind === "object" || kind === "array" || kind === "null") {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      throw new CliError(`Expected ${kind} as JSON, got ${value}`);
    }
    if (
      (kind === "object" &&
        (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) ||
      (kind === "array" && !Array.isArray(parsed)) ||
      (kind === "null" && parsed !== null)
    ) {
      throw new CliError(`Expected ${kind} as JSON, got ${value}`);
    }
    return parsed;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function addParameterValue(
  input: ApiCallInput,
  parameter: ApiParameter,
  raw: string | undefined,
): void {
  const target =
    parameter.location === "path"
      ? input.path
      : parameter.location === "query"
        ? input.query
        : parameter.location === "header"
          ? input.headers
          : input.cookies;
  if (raw === undefined && parameter.kind !== "boolean") {
    throw new CliError(`--${parameter.cliName} requires a value`);
  }
  const parsed = parseJsonValue(raw ?? "true", parameter.itemKind ?? parameter.kind);
  if (parameter.kind === "array") {
    const existing = target[parameter.name];
    if (Array.isArray(existing)) existing.push(parsed);
    else target[parameter.name] = [parsed];
  } else {
    target[parameter.name] = parsed;
  }
}

function setBodyValue(
  body: Record<string, JsonValue>,
  raw: string | undefined,
  field: ApiBodyField,
): void {
  const kind = field.kind === "array" ? field.itemKind : field.kind;
  const parsed = parseJsonValue(raw ?? "true", kind);
  const existing = body[field.name];
  if (field.kind === "array") {
    if (Array.isArray(parsed)) body[field.name] = parsed;
    else if (Array.isArray(existing)) existing.push(parsed);
    else body[field.name] = [parsed];
  } else {
    body[field.name] = parsed;
  }
}

function splitOption(token: string): { name: string; inline?: string; negated: boolean } {
  const separator = token.indexOf("=");
  const rawName = separator === -1 ? token.slice(2) : token.slice(2, separator);
  return {
    name: rawName.startsWith("no-") ? rawName.slice(3) : rawName,
    ...(separator === -1 ? {} : { inline: token.slice(separator + 1) }),
    negated: rawName.startsWith("no-"),
  };
}

async function readBodyFile(path: string): Promise<JsonValue> {
  const text =
    path === "-" ? await streamText(process.stdin) : await readFile(path, "utf8");
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new CliError(
      `Invalid JSON in ${path === "-" ? "stdin" : path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function parseOperationInput(
  operation: ApiOperation,
  tokens: string[],
): Promise<ApiCallInput> {
  const input: ApiCallInput = {
    path: {},
    query: {},
    headers: {},
    cookies: {},
  };
  const parameterByFlag = new Map<string, ApiParameter>();
  for (const parameter of operation.parameters) {
    if (parameter.location !== "path") {
      parameterByFlag.set(parameter.cliName, parameter);
    }
  }
  if (operation.operationId === "prompts_get") {
    const version = operation.parameters.find(
      (parameter) => parameter.location === "query" && parameter.name === "version",
    );
    if (version) parameterByFlag.set("prompt-version", version);
  }
  const positionals: string[] = [];
  let fieldBody: Record<string, JsonValue> | undefined;
  let completeBody: JsonValue | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const option = splitOption(token);
    const parameter = parameterByFlag.get(option.name);
    const bodyField = operation.requestBody?.legacyFieldFlags
      ? operation.requestBody.fields.find(
          (candidate) => candidate.name === option.name.split(".")[0],
        )
      : undefined;
    if (bodyField && option.name.includes(".")) {
      throw new CliError(
        `Nested body option --${option.name} is unsupported; pass --${bodyField.name} with a JSON object or use --body-json`,
      );
    }
    const isBoolean =
      parameter?.kind === "boolean" || bodyField?.kind === "boolean";
    let raw = option.inline;
    if (
      raw === undefined &&
      !isBoolean &&
      tokens[index + 1] !== undefined &&
      !tokens[index + 1].startsWith("--")
    ) {
      raw = tokens[++index];
    }
    if (option.name === "body-json") {
      if (raw === undefined) throw new CliError("--body-json requires a value");
      try {
        completeBody = JSON.parse(raw) as JsonValue;
      } catch (error) {
        throw new CliError(
          `Invalid --body-json: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (option.name === "body-file") {
      if (raw === undefined) throw new CliError("--body-file requires a path or -");
      completeBody = await readBodyFile(raw);
      continue;
    }
    if (parameter) {
      if (option.negated && parameter.kind !== "boolean") {
        throw new CliError(`--no-${option.name} is only valid for boolean options`);
      }
      addParameterValue(input, parameter, option.negated ? "false" : raw);
      continue;
    }
    if (!operation.requestBody) {
      throw new CliError(`Unknown option --${option.name}`);
    }
    if (!operation.requestBody.legacyFieldFlags) {
      throw new CliError(
        `${operation.operationId} requires --body-json or --body-file for request bodies`,
      );
    }
    const field = bodyField;
    if (!field) throw new CliError(`Unknown option --${option.name}`);
    if (option.negated && field.kind !== "boolean") {
      throw new CliError(`--no-${option.name} is only valid for boolean options`);
    }
    if (raw === undefined && field.kind !== "boolean") {
      throw new CliError(`--${option.name} requires a value`);
    }
    fieldBody ??= {};
    setBodyValue(fieldBody, option.negated ? "false" : raw, field);
  }
  if (completeBody !== undefined && fieldBody !== undefined) {
    throw new CliError("Do not mix --body-json/--body-file with body field flags");
  }
  if (positionals.length !== operation.pathParameterOrder.length) {
    throw new CliError(
      `${operation.operationId} expects ${operation.pathParameterOrder.length} path argument(s), got ${positionals.length}`,
    );
  }
  for (let index = 0; index < operation.pathParameterOrder.length; index++) {
    const name = operation.pathParameterOrder[index];
    const parameter = operation.parameters.find(
      (candidate) => candidate.location === "path" && candidate.name === name,
    );
    if (!parameter) throw new CliError(`Missing path parameter contract: ${name}`);
    input.path[name] = parseJsonValue(positionals[index], parameter.kind);
  }
  for (const parameter of operation.parameters) {
    const target =
      parameter.location === "path"
        ? input.path
        : parameter.location === "query"
          ? input.query
          : parameter.location === "header"
            ? input.headers
            : input.cookies;
    if (parameter.required && target[parameter.name] === undefined) {
      throw new CliError(`Missing required option --${parameter.cliName}`);
    }
  }
  let body = completeBody !== undefined ? completeBody : fieldBody;
  if (completeBody === undefined && operation.requestBody?.legacyFieldFlags) {
    const missing = operation.requestBody.fields
      .filter((field) => field.required && fieldBody?.[field.name] === undefined)
      .map((field) => `--${field.name}`);
    if (missing.length > 0) {
      throw new CliError(`Missing required body option(s): ${missing.join(", ")}`);
    }
    if (body === undefined && operation.requestBody.required) body = {};
  }
  if (operation.requestBody?.required && body === undefined) {
    throw new CliError(`${operation.operationId} requires a request body`);
  }
  if (body !== undefined) input.body = body;
  return input;
}

export function schemaOutput(contract: ApiContract) {
  return {
    schemaVersion: 1,
    apiVersion: contract.apiVersion,
    sourceSha256: contract.sourceSha256,
    resources: [...canonicalResourceMap(contract)].map(([name, operations]) => ({
      name,
      actions: operations.map((operation) => ({
        name: operation.command.action,
        aliases: operation.command.aliases ?? [],
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        deprecated: Boolean(operation.deprecated),
        auth: operation.auth,
        pathParameterOrder: operation.pathParameterOrder,
        parameters: operation.parameters,
        ...(operation.requestBody
          ? { requestBody: operation.requestBody }
          : {}),
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(operation.description
          ? { description: operation.description }
          : {}),
      })),
    })),
  };
}

export async function writeResult(
  result: ApiResult,
  config: RuntimeConfig,
): Promise<void> {
  if (config.output) {
    const content =
      result.body === null
        ? ""
        : typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2);
    await writeFile(config.output, content ?? "");
  } else if (config.json) {
    process.stdout.write(
      `${JSON.stringify({ status: result.status, headers: result.headers, body: result.body })}\n`,
    );
  } else if (typeof result.body === "string") {
    process.stdout.write(result.body.endsWith("\n") ? result.body : `${result.body}\n`);
  } else if (result.body !== null) {
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

export async function runApi(
  config: RuntimeConfig,
  args: string[],
  providedCatalog?: ApiContractCatalog,
): Promise<void> {
  const catalog = providedCatalog ?? (await loadContractCatalog());
  if (args[0] === "versions") {
    const action = args[1] ?? "list";
    if (action === "list") {
      process.stdout.write(
        `${catalog.versions.map((entry) => entry.version).join("\n")}\n`,
      );
      return;
    }
    if (action === "current") {
      const resolved = await resolveContractVersion({
        requested: config.apiVersion,
        host: config.host,
        timeoutMs: config.timeoutMs,
        catalog,
      });
      process.stdout.write(`${resolved.version}\n`);
      return;
    }
    if (action === "detect") {
      const resolved = await resolveContractVersion({
        requested: "auto",
        host: config.host,
        timeoutMs: config.timeoutMs,
        catalog,
      });
      process.stdout.write(
        `${resolved.detected} -> ${resolved.version}\n`,
      );
      return;
    }
    throw new CliError(`Unknown versions action: ${action}`);
  }
  const resolved = await resolveContractVersion({
    requested: config.apiVersion,
    host: config.host,
    timeoutMs: config.timeoutMs,
    catalog,
  });
  const contract = await loadApiContract(resolved.version);
  if (
    args.length === 0 ||
    (args[0] === "help" && args.length === 1) ||
    args[0] === "--help" ||
    args[0] === "-h"
  ) {
    printApiHelp(contract);
    return;
  }
  if (["schema", "__schema", "__spec"].includes(args[0])) {
    const schema = schemaOutput(contract);
    if (config.json) process.stdout.write(`${JSON.stringify(schema)}\n`);
    else printApiHelp(contract);
    return;
  }
  if (args[0] === "help") {
    if (!args[1]) printApiHelp(contract);
    else if (!args[2]) printResourceHelp(contract, args[1]);
    else printOperationHelp(operationByCommand(contract, args[1], args[2]));
    return;
  }
  const resource = args[0];
  if (!args[1] || args[1] === "help" || args[1] === "--help" || args[1] === "-h") {
    printResourceHelp(contract, resource);
    return;
  }
  const operation = operationByCommand(contract, resource, args[1]);
  if (args[2] === "help" || args[2] === "--help" || args[2] === "-h") {
    printOperationHelp(operation);
    return;
  }
  assertOperationCallable(operation, contract.apiVersion);
  const input = await parseOperationInput(operation, args.slice(2));
  const client = createApiClient({
    host: config.host,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    timeoutMs: config.timeoutMs,
  });
  if (config.curl) {
    process.stdout.write(
      `${renderCurl(client.prepare(operation, input), { showSecrets: config.showSecrets })}\n`,
    );
    return;
  }
  await writeResult(await client.call(operation, input), config);
}

export async function run(argv: string[]): Promise<void> {
  try {
    const globals = extractGlobals(argv.slice(2));
    const [command, ...args] = globals.args;
    if (command === "--version") {
      process.stdout.write(`${packageJson.version}\n`);
      return;
    }
    if (!command || command === "--help" || command === "-h") {
      printHelp();
      return;
    }
    if (command === "get-skill") {
      await getSkill();
      return;
    }
    if (command !== "api") {
      throw new CliError(`Unknown command: ${command}`);
    }
    await runApi(await runtimeConfig(globals), args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

import { parse } from "yaml";

import { RESERVED_OPTION_NAMES } from "../flags";
import { kebabCase, planCommandNames } from "./naming";
import rawOverrides from "./overrides.json";
import type {
  ApiBodyField,
  ApiContract,
  ApiOperation,
  ApiParameter,
  ContractOverrides,
  HttpMethod,
  ValueKind,
} from "./types";

interface ContractSource {
  version: string;
  ref: string;
  sha256: string;
}

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

const LEGACY_FIELD_FLAGS_UNSUPPORTED = new Set([
  "annotationQueues_createQueue",
  "datasetItems_create",
  "datasetRunItems_create",
  "datasets_create",
  "ingestion_batch",
  "legacy_scoreV1_create",
  "models_create",
  "opentelemetry_exportTraces",
  "promptVersion_update",
  "prompts_create",
  "scim_createUser",
  "score_create",
  "scores_create",
  "trace_deleteMultiple",
  "unstable_dashboardWidgets_create",
  "unstable_dashboards_addPlacement",
  "unstable_dashboards_create",
  "unstable_evaluationRules_create",
  "unstable_evaluators_create",
]);

function resolveLocalRef(
  document: Record<string, any>,
  value: Record<string, any>,
): Record<string, any> {
  let current = value;
  const seen = new Set<string>();
  while (current?.$ref) {
    const ref = String(current.$ref);
    if (!ref.startsWith("#/")) {
      throw new Error(`External OpenAPI references are unsupported: ${ref}`);
    }
    if (seen.has(ref)) throw new Error(`Circular OpenAPI reference: ${ref}`);
    seen.add(ref);
    current = ref
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((node, segment) => node?.[segment], document);
    if (!current) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
  }
  return current;
}

function schemaKind(
  document: Record<string, any>,
  rawSchema: Record<string, any> = {},
): ValueKind {
  const schema = resolveLocalRef(document, rawSchema);
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate: string) => candidate !== "null")
    : schema.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  if (type === "object" || schema.properties || schema.additionalProperties) {
    return "object";
  }
  if (type === "null") return "null";
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    const branches = schema.allOf ?? schema.oneOf ?? schema.anyOf;
    const kinds = new Set<ValueKind>(
      branches.map((branch: Record<string, any>) => schemaKind(document, branch)),
    );
    return kinds.size === 1 ? [...kinds][0] : "object";
  }
  return "string";
}

const OVERRIDES = rawOverrides as ContractOverrides;

interface AliasTarget {
  operationId: string;
  parameters: ApiParameter[];
  requestBody?: ApiOperation["requestBody"];
}

function applyParameterFlagAliases(
  operation: AliasTarget,
  overrides: ContractOverrides,
): void {
  const aliases = overrides.parameterFlagAliases[operation.operationId];
  if (!aliases) return;
  // Every flag namespace the runtime resolves before or alongside parameters:
  // reserved/global flags, parameter cliNames, and legacy body-field flags.
  const taken = new Set<string>(RESERVED_OPTION_NAMES);
  for (const parameter of operation.parameters) {
    if (parameter.location !== "path") taken.add(parameter.cliName);
  }
  if (operation.requestBody?.legacyFieldFlags) {
    for (const field of operation.requestBody.fields) taken.add(field.name);
  }
  for (const spec of aliases) {
    if ((spec.location as string) === "path") {
      throw new Error(
        `${operation.operationId}: flag alias --${spec.flag} targets path parameter "${spec.parameter}"; path parameters are positional and cannot have flag aliases`,
      );
    }
    const parameter = operation.parameters.find(
      (candidate) =>
        candidate.location === spec.location && candidate.name === spec.parameter,
    );
    // A missing parameter is tolerated per version (specs evolve); an entry
    // applied in no snapshot at all is rejected by assertOverridesApplied.
    if (!parameter) continue;
    if (taken.has(spec.flag)) {
      throw new Error(
        `${operation.operationId}: flag alias --${spec.flag} collides with an existing option`,
      );
    }
    taken.add(spec.flag);
    parameter.cliAliases = [...(parameter.cliAliases ?? []), spec.flag];
  }
}

export function assertOverridesApplied(
  contracts: ApiContract[],
  overrides: ContractOverrides = OVERRIDES,
): void {
  for (const [operationId, aliases] of Object.entries(
    overrides.parameterFlagAliases,
  )) {
    for (const spec of aliases) {
      const applied = contracts.some((contract) =>
        contract.operations.some(
          (operation) =>
            operation.operationId === operationId &&
            operation.parameters.some(
              (parameter) =>
                parameter.location === spec.location &&
                parameter.name === spec.parameter &&
                parameter.cliAliases?.includes(spec.flag),
            ),
        ),
      );
      if (!applied) {
        throw new Error(
          `overrides.json: flag alias --${spec.flag} for ${operationId} ${spec.location} parameter "${spec.parameter}" is applied in no compiled contract; fix or remove the entry`,
        );
      }
    }
  }
  for (const [version, byOperation] of Object.entries(overrides.commandOverrides)) {
    const contract = contracts.find(
      (candidate) => candidate.apiVersion === version,
    );
    if (!contract) {
      throw new Error(
        `overrides.json: commandOverrides references unknown version ${version}`,
      );
    }
    for (const [operationId, override] of Object.entries(byOperation)) {
      const operation = contract.operations.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (!operation) {
        throw new Error(
          `overrides.json: commandOverrides ${version}/${operationId} matches no operation`,
        );
      }
      if (
        (override.resource && operation.command.resource !== override.resource) ||
        (override.action && operation.command.action !== override.action)
      ) {
        throw new Error(
          `overrides.json: commandOverrides ${version}/${operationId} was not applied`,
        );
      }
    }
  }
}

function parameterDefaults(location: string): { style: string; explode: boolean } {
  if (location === "query" || location === "cookie") {
    return { style: "form", explode: true };
  }
  return { style: "simple", explode: false };
}

function mergeParameters(
  document: Record<string, any>,
  pathParameters: any[] = [],
  operationParameters: any[] = [],
): ApiParameter[] {
  const merged = new Map<string, ApiParameter>();
  for (const raw of [...pathParameters, ...operationParameters]) {
    const parameter = resolveLocalRef(document, raw);
    const location = parameter.in;
    if (!parameter.name || !["path", "query", "header", "cookie"].includes(location)) {
      continue;
    }
    const schema = resolveLocalRef(document, parameter.schema ?? { type: "string" });
    const defaults = parameterDefaults(location);
    const kind = schemaKind(document, schema);
    merged.set(`${location}:${parameter.name}`, {
      location,
      name: String(parameter.name),
      cliName: kebabCase(String(parameter.name)),
      required: location === "path" || Boolean(parameter.required),
      style: parameter.style ?? defaults.style,
      explode: parameter.explode ?? defaults.explode,
      kind,
      ...(kind === "array"
        ? { itemKind: schemaKind(document, schema.items ?? { type: "string" }) }
        : {}),
    });
  }
  return [...merged.values()].sort((left, right) => {
    if (left.location !== right.location) {
      return left.location.localeCompare(right.location);
    }
    return left.name.localeCompare(right.name);
  });
}

function collectBodyFields(
  document: Record<string, any>,
  rawSchema: Record<string, any>,
): ApiBodyField[] {
  const fields = new Map<string, ApiBodyField>();
  const visit = (raw: Record<string, any>, inheritedRequired = new Set<string>()) => {
    const schema = resolveLocalRef(document, raw);
    const required = new Set<string>([
      ...inheritedRequired,
      ...(schema.required ?? []),
    ]);
    for (const branch of [
      ...(schema.allOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
    ]) {
      visit(branch, required);
    }
    for (const [name, rawProperty] of Object.entries<Record<string, any>>(
      schema.properties ?? {},
    )) {
      const property = resolveLocalRef(document, rawProperty);
      const existing = fields.get(name);
      const kind = existing?.kind ?? schemaKind(document, property);
      fields.set(name, {
        name,
        required: Boolean(existing?.required || required.has(name)),
        kind,
        ...(kind === "array"
          ? {
              itemKind:
                existing?.itemKind ??
                schemaKind(document, property.items ?? { type: "string" }),
            }
          : {}),
        ...(property.description
          ? { description: String(property.description) }
          : existing?.description
            ? { description: existing.description }
            : {}),
      });
    }
  };
  visit(rawSchema);
  return [...fields.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function normalizeAuth(
  document: Record<string, any>,
  operation: Record<string, any>,
): ApiOperation["auth"] {
  const requirements = operation.security ?? document.security ?? [];
  const schemes = [
    ...new Set<string>(
      requirements.flatMap((requirement: Record<string, any>) =>
        Object.keys(requirement ?? {}),
      ),
    ),
  ].sort();
  for (const name of schemes) {
    const scheme = resolveLocalRef(
      document,
      document.components?.securitySchemes?.[name] ?? {},
    );
    if (scheme.type !== "http" || scheme.scheme !== "basic") {
      throw new Error(`Unsupported authentication scheme: ${name}`);
    }
  }
  return {
    required:
      requirements.length > 0 &&
      !requirements.some(
        (requirement: Record<string, any>) =>
          Object.keys(requirement ?? {}).length === 0,
      ),
    schemes,
  };
}

function normalizeRequestBody(
  document: Record<string, any>,
  operationId: string,
  raw: Record<string, any> | undefined,
): ApiOperation["requestBody"] {
  if (!raw) return undefined;
  const body = resolveLocalRef(document, raw);
  const contentTypes = Object.keys(body.content ?? {});
  const contentType =
    contentTypes.find((candidate) => candidate === "application/json") ??
    contentTypes.find((candidate) => candidate.includes("+json"));
  if (!contentType) {
    throw new Error(
      `${operationId}: only JSON request bodies are supported (${contentTypes.join(", ")})`,
    );
  }
  const rawSchema = body.content?.[contentType]?.schema;
  if (!rawSchema) throw new Error(`${operationId}: request body has no schema`);
  return {
    required: Boolean(body.required),
    contentType,
    legacyFieldFlags: !LEGACY_FIELD_FLAGS_UNSUPPORTED.has(operationId),
    fields: collectBodyFields(document, rawSchema),
  };
}

export function compileApiContract(
  source: ContractSource,
  raw: string,
  overrides: ContractOverrides = OVERRIDES,
): ApiContract {
  const document = parse(raw, {
    maxAliasCount: 100_000,
    uniqueKeys: true,
  }) as Record<string, any>;
  if (!String(document.openapi ?? "").startsWith("3.0.")) {
    throw new Error(`${source.ref}: expected OpenAPI 3.0.x`);
  }
  const pending: Array<{
    key: string;
    operationId: string;
    method: HttpMethod;
    path: string;
    deprecated?: true;
    tags: string[];
    auth: ApiOperation["auth"];
    pathParameterOrder: string[];
    parameters: ApiParameter[];
    requestBody?: ApiOperation["requestBody"];
    summary?: string;
    description?: string;
  }> = [];
  for (const [path, rawPathItem] of Object.entries<Record<string, any>>(
    document.paths ?? {},
  )) {
    const pathItem = resolveLocalRef(document, rawPathItem);
    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue;
      const operation = resolveLocalRef(document, pathItem[method]);
      if (operation.callbacks) {
        throw new Error(`${method.toUpperCase()} ${path}: callbacks are unsupported`);
      }
      const operationId = String(
        operation.operationId ?? `${method.toUpperCase()}:${path}`,
      );
      pending.push({
        key: `${method.toUpperCase()} ${path}`,
        operationId,
        method: method.toUpperCase() as HttpMethod,
        path,
        ...(operation.deprecated === true ? { deprecated: true as const } : {}),
        tags: (operation.tags ?? []).map(String),
        auth: normalizeAuth(document, operation),
        pathParameterOrder: [...path.matchAll(/\{([^}]+)\}/g)].map(
          (match) => match[1],
        ),
        parameters: mergeParameters(
          document,
          pathItem.parameters,
          operation.parameters,
        ),
        requestBody: normalizeRequestBody(
          document,
          operationId,
          operation.requestBody,
        ),
        ...(operation.summary ? { summary: String(operation.summary) } : {}),
        ...(operation.description
          ? { description: String(operation.description) }
          : {}),
      });
    }
  }
  pending.sort((left, right) => {
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.method.localeCompare(right.method);
  });
  for (const operation of pending) {
    applyParameterFlagAliases(operation, overrides);
  }
  const names = planCommandNames(pending);
  const commandOverrides = overrides.commandOverrides[source.version] ?? {};
  pending.forEach((operation, index) => {
    const override = commandOverrides[operation.operationId];
    if (override) names[index] = { ...names[index], ...override };
  });
  const seenCommands = new Set<string>();
  for (const name of names) {
    const commands = [
      `${name.resource} ${name.action}`,
      ...(name.aliases ?? []).map((alias) => `${alias.resource} ${alias.action}`),
    ];
    for (const command of commands) {
      if (seenCommands.has(command)) {
        throw new Error(`${source.ref}: duplicate command ${command}`);
      }
      seenCommands.add(command);
    }
  }
  const operations: ApiOperation[] = pending.map(
    ({ tags: _tags, ...operation }, index) => ({
      ...operation,
      command: names[index],
    }),
  );
  const operationIds = new Set(operations.map((operation) => operation.operationId));
  if (operationIds.size !== operations.length) {
    throw new Error(`${source.ref}: duplicate operationId`);
  }
  return {
    schemaVersion: 1,
    apiVersion: source.version,
    sourceSha256: source.sha256,
    operations,
  };
}

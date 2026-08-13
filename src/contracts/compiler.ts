import { parse } from "yaml";

import { kebabCase, planCommandNames } from "../../conformance/src/naming";
import type {
  ApiBodyField,
  ApiContract,
  ApiOperation,
  ApiParameter,
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
  const names = planCommandNames(pending);
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

import { parse } from "yaml";

import { kebabCase, planCommandNames } from "./naming";
import {
  expandSchemaBranches,
  resolveLocalRef,
  sampleFromSchema,
} from "./schema";
import type {
  BodyBranch,
  CatalogEntry,
  HttpMethod,
  JsonSchema,
  Manifest,
  OperationContract,
  ParameterContract,
  RequestBodyContract,
  ResponseContract,
} from "./types";

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

interface RawOperation {
  key: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  tags: string[];
  auth: {
    required: boolean;
    schemes: string[];
  };
  pathParameterOrder: string[];
  parameters: ParameterContract[];
  requestBody?: RequestBodyContract;
  responses: ResponseContract[];
}

function normalizeAuth(
  document: Record<string, any>,
  operation: Record<string, any>,
  unsupported: Set<string>,
): { required: boolean; schemes: string[] } {
  const requirements = operation.security ?? document.security ?? [];
  const schemes = [
    ...new Set<string>(
      requirements.flatMap((requirement: Record<string, any>) =>
        Object.keys(requirement ?? {}),
      ),
    ),
  ].sort();
  const required =
    requirements.length > 0 &&
    !requirements.some(
      (requirement: Record<string, any>) => Object.keys(requirement ?? {}).length === 0,
    );
  for (const key of schemes) {
    const scheme = document.components?.securitySchemes?.[key];
    if (scheme?.type !== "http" || scheme?.scheme !== "basic") {
      unsupported.add(`auth-scheme:${key}`);
    }
  }
  return { required, schemes };
}

export interface CompiledSpec {
  document: Record<string, any>;
  manifest: Manifest;
  pathCount: number;
  unsupported: string[];
  sourceIssues: string[];
}

function parameterDefaults(location: string): { style: string; explode: boolean } {
  if (location === "query" || location === "cookie") {
    return { style: "form", explode: true };
  }
  return { style: "simple", explode: false };
}

function pathParameterOrder(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function mergeParameters(
  document: Record<string, any>,
  pathParameters: any[] = [],
  operationParameters: any[] = [],
): ParameterContract[] {
  const merged = new Map<string, ParameterContract>();
  for (const raw of [...pathParameters, ...operationParameters]) {
    const parameter = resolveLocalRef(document, raw);
    const location = parameter?.in;
    if (!["path", "query", "header", "cookie"].includes(location)) continue;
    if (!parameter.name) continue;
    const defaults = parameterDefaults(location);
    const schema = (parameter.schema ?? { type: "string" }) as JsonSchema;
    merged.set(`${location}:${parameter.name}`, {
      location,
      name: String(parameter.name),
      cliName: kebabCase(String(parameter.name)),
      required: location === "path" || Boolean(parameter.required),
      style: parameter.style ?? defaults.style,
      explode: parameter.explode ?? defaults.explode,
      schema,
      sample: sampleFromSchema(document, schema, String(parameter.name)),
    });
  }
  return [...merged.values()].sort((left, right) => {
    if (left.location !== right.location) {
      return left.location.localeCompare(right.location);
    }
    return left.name.localeCompare(right.name);
  });
}

function branchId(schema: JsonSchema, sample: any, index: number): string {
  const discriminator = schema.discriminator?.propertyName;
  const value = discriminator && sample && typeof sample === "object"
    ? sample[discriminator]
    : sample?.type;
  const suffix = typeof value === "string" ? `-${kebabCase(value)}` : "";
  return `branch-${String(index + 1).padStart(2, "0")}${suffix}`;
}

function normalizeRequestBody(
  document: Record<string, any>,
  raw: any,
  unsupported: Set<string>,
): RequestBodyContract | undefined {
  if (!raw) return undefined;
  const requestBody = resolveLocalRef(document, raw);
  const contentTypes = Object.keys(requestBody.content ?? {});
  const contentType =
    contentTypes.find((candidate) => candidate === "application/json") ??
    contentTypes.find((candidate) => candidate.includes("+json")) ??
    contentTypes[0];
  if (!contentType) {
    unsupported.add("request-body-without-content");
    return undefined;
  }
  if (!contentType.includes("json")) {
    unsupported.add(`request-content-type:${contentType}`);
  }
  const schema = requestBody.content[contentType]?.schema as JsonSchema | undefined;
  if (!schema) {
    unsupported.add(`request-body-without-schema:${contentType}`);
    return {
      required: Boolean(requestBody.required),
      contentType,
      branches: [],
    };
  }
  const expanded = expandSchemaBranches(document, schema);
  const branches: BodyBranch[] = expanded.map((branch, index) => {
    const sample = sampleFromSchema(document, branch, `body-${index + 1}`);
    return {
      id: branchId(branch, sample, index),
      requiredFields: [...new Set<string>(branch.required ?? [])].sort(),
      schema: branch,
      sample,
    };
  });
  return {
    required: Boolean(requestBody.required),
    contentType,
    branches,
  };
}

function concreteStatus(key: string): number {
  if (/^[1-5][0-9]{2}$/.test(key)) return Number(key);
  if (/^[1-5]XX$/i.test(key)) return Number(key[0]) * 100;
  if (key === "default") return 520;
  throw new Error(`Unsupported OpenAPI response key: ${key}`);
}

function normalizeResponses(
  document: Record<string, any>,
  rawResponses: Record<string, any> = {},
  unsupported: Set<string>,
): ResponseContract[] {
  return Object.entries(rawResponses)
    .map(([key, unresolved]) => {
      const response = resolveLocalRef(document, unresolved);
      const contentTypes = Object.keys(response.content ?? {});
      const contentType =
        contentTypes.find((candidate) => candidate === "application/json") ??
        contentTypes.find((candidate) => candidate.includes("+json")) ??
        contentTypes[0];
      if (contentType && !contentType.includes("json")) {
        unsupported.add(`response-content-type:${contentType}`);
      }
      const schema = contentType
        ? (response.content[contentType]?.schema as JsonSchema | undefined)
        : undefined;
      return {
        key,
        status: concreteStatus(key),
        ...(response.description ? { description: String(response.description) } : {}),
        ...(contentType ? { contentType } : {}),
        ...(schema
          ? { sample: sampleFromSchema(document, schema, `response-${key}`) }
          : {}),
      } satisfies ResponseContract;
    })
    .sort((left, right) => {
      if (left.status !== right.status) return left.status - right.status;
      return left.key.localeCompare(right.key);
    });
}

export function compileOpenApi(
  entry: CatalogEntry,
  raw: string,
  specPath: string,
): CompiledSpec {
  const document = parse(raw, {
    maxAliasCount: 100_000,
    uniqueKeys: true,
  }) as Record<string, any>;
  if (!String(document.openapi ?? "").startsWith("3.0.")) {
    throw new Error(`${entry.ref}: expected OpenAPI 3.0.x, got ${document.openapi}`);
  }
  const unsupported = new Set<string>();
  const operations: RawOperation[] = [];
  for (const [path, rawPathItem] of Object.entries<any>(document.paths ?? {})) {
    const pathItem = resolveLocalRef(document, rawPathItem);
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (operation.callbacks) unsupported.add("callbacks");
      const operationId =
        operation.operationId ?? `${method.toUpperCase()}:${path}`;
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        operationId,
        method: method.toUpperCase() as HttpMethod,
        path,
        ...(operation.summary ? { summary: String(operation.summary) } : {}),
        tags: (operation.tags ?? []).map(String),
        auth: normalizeAuth(document, operation, unsupported),
        pathParameterOrder: pathParameterOrder(path),
        parameters: mergeParameters(
          document,
          pathItem.parameters,
          operation.parameters,
        ),
        requestBody: normalizeRequestBody(
          document,
          operation.requestBody,
          unsupported,
        ),
        responses: normalizeResponses(
          document,
          operation.responses,
          unsupported,
        ),
      });
    }
  }
  operations.sort((left, right) => {
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.method.localeCompare(right.method);
  });
  const names = planCommandNames(operations);
  const normalized: OperationContract[] = operations.map((operation, index) => ({
    ...operation,
    command: names[index],
  }));
  for (const operation of normalized) {
    for (const parameter of operation.parameters) {
      if (parameter.location === "path" && parameter.style !== "simple") {
        unsupported.add(`path-style:${parameter.style}`);
      }
      if (parameter.location === "query" && parameter.style !== "form") {
        unsupported.add(`query-style:${parameter.style}`);
      }
    }
  }
  return {
    document,
    pathCount: Object.keys(document.paths ?? {}).length,
    unsupported: [...unsupported].sort(),
    sourceIssues: [...(entry.knownIssues ?? [])].sort(),
    manifest: {
      schemaVersion: 1,
      version: entry.version,
      source: {
        ref: entry.ref,
        commit: entry.commit,
        sha256: entry.sha256,
        path: specPath,
      },
      openapi: String(document.openapi),
      generatedAt: "deterministic",
      operations: normalized,
    },
  };
}

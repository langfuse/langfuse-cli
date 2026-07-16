import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  generatedDir,
  readVerifiedSpec,
} from "./catalog";
import { compileOpenApi, type CompiledSpec } from "./openapi";
import { invalidValueForSchema } from "./schema";
import { expectedRequest } from "./serialize";
import type {
  CatalogEntry,
  ConformanceVector,
  CoverageReport,
  JsonValue,
  OperationContract,
  ResponseContract,
  SemanticInput,
} from "./types";

export interface GeneratedCorpus {
  compiled: CompiledSpec;
  vectors: ConformanceVector[];
  coverage: CoverageReport;
  files: {
    manifest: string;
    vectors: string;
    coverage: string;
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyInput(): SemanticInput {
  return { path: {}, query: {}, headers: {}, cookies: {} };
}

function setParameter(
  input: SemanticInput,
  operation: OperationContract,
  name: string,
  value: JsonValue,
): void {
  const parameter = operation.parameters.find(
    (candidate) => candidate.name === name,
  );
  if (!parameter) throw new Error(`${operation.operationId}: missing ${name}`);
  const target =
    parameter.location === "path"
      ? input.path
      : parameter.location === "query"
        ? input.query
        : parameter.location === "header"
          ? input.headers
          : input.cookies;
  target[name] = value;
}

function deleteParameter(
  input: SemanticInput,
  operation: OperationContract,
  name: string,
): void {
  const parameter = operation.parameters.find(
    (candidate) => candidate.name === name,
  );
  if (!parameter) return;
  const target =
    parameter.location === "path"
      ? input.path
      : parameter.location === "query"
        ? input.query
        : parameter.location === "header"
          ? input.headers
          : input.cookies;
  delete target[name];
}

function minimalInput(
  operation: OperationContract,
  bodyBranch = operation.requestBody?.branches[0],
): SemanticInput {
  const input = emptyInput();
  for (const parameter of operation.parameters) {
    if (parameter.required) {
      setParameter(input, operation, parameter.name, clone(parameter.sample));
    }
  }
  if (operation.requestBody?.required && bodyBranch) {
    input.body = clone(bodyBranch.sample);
  }
  return input;
}

function requestWithAuth(operation: OperationContract, input: SemanticInput) {
  const request = expectedRequest(operation, input);
  if (operation.auth.required && operation.auth.schemes.includes("BasicAuth")) {
    request.headers.authorization =
      "Basic Y29uZm9ybWFuY2UtcHVibGljLWtleTpjb25mb3JtYW5jZS1zZWNyZXQta2V5";
  }
  return request;
}

function successResponse(operation: OperationContract): ResponseContract {
  return (
    operation.responses.find(
      (response) => response.status >= 200 && response.status < 300,
    ) ?? {
      key: "200",
      status: 200,
      contentType: "application/json",
      sample: { ok: true },
    }
  );
}

function vectorId(
  version: string,
  operation: OperationContract | undefined,
  kind: string,
  suffix?: string,
): string {
  return [version, operation?.operationId ?? "spec", kind, suffix]
    .filter(Boolean)
    .join(":");
}

function requestVector(
  version: string,
  operation: OperationContract,
  kind: ConformanceVector["kind"],
  input: SemanticInput,
  covers: string[],
  suffix?: string,
): ConformanceVector {
  return {
    schemaVersion: 1,
    id: vectorId(version, operation, kind, suffix),
    version,
    kind,
    operationKey: operation.key,
    operationId: operation.operationId,
    command: operation.command,
    input,
    expectedRequest: requestWithAuth(operation, input),
    response: successResponse(operation),
    expected: { reachesServer: true, exit: "zero" },
    covers,
  };
}

export function generateVectors(compiled: CompiledSpec): ConformanceVector[] {
  const { manifest } = compiled;
  const vectors: ConformanceVector[] = [
    {
      schemaVersion: 1,
      id: vectorId(manifest.version, undefined, "discovery"),
      version: manifest.version,
      kind: "discovery",
      expected: { reachesServer: false, exit: "zero" },
      covers: ["openapi.paths", "operationId", "tags"],
    },
  ];
  for (const operation of manifest.operations) {
    vectors.push({
      schemaVersion: 1,
      id: vectorId(manifest.version, operation, "help"),
      version: manifest.version,
      kind: "help",
      operationKey: operation.key,
      operationId: operation.operationId,
      command: operation.command,
      expected: { reachesServer: false, exit: "zero" },
      covers: [
        `operation:${operation.operationId}`,
        ...operation.parameters.map(
          (parameter) => `parameter:${parameter.location}:${parameter.name}`,
        ),
      ],
    });

    const minimal = minimalInput(operation);
    vectors.push(
      requestVector(
        manifest.version,
        operation,
        "minimal-request",
        minimal,
        [`operation:${operation.operationId}`, "request:minimal"],
      ),
    );

    for (const parameter of operation.parameters) {
      const input = minimalInput(operation);
      setParameter(input, operation, parameter.name, clone(parameter.sample));
      vectors.push(
        requestVector(
          manifest.version,
          operation,
          "parameter-serialization",
          input,
          [
            `parameter:${parameter.location}:${parameter.name}`,
            `serialization:${parameter.style}:explode=${parameter.explode}`,
          ],
          `${parameter.location}-${parameter.cliName}`,
        ),
      );
      if (parameter.required) {
        const missing = minimalInput(operation);
        deleteParameter(missing, operation, parameter.name);
        vectors.push({
          schemaVersion: 1,
          id: vectorId(
            manifest.version,
            operation,
            "missing-required-parameter",
            `${parameter.location}-${parameter.cliName}`,
          ),
          version: manifest.version,
          kind: "missing-required-parameter",
          operationKey: operation.key,
          operationId: operation.operationId,
          command: operation.command,
          input: missing,
          expected: {
            reachesServer: false,
            exit: "nonzero",
            errorContains: parameter.cliName,
          },
          covers: [`required-parameter:${parameter.location}:${parameter.name}`],
        });
      }
      const invalid = invalidValueForSchema(parameter.schema);
      if (invalid !== undefined) {
        const invalidInput = minimalInput(operation);
        setParameter(invalidInput, operation, parameter.name, invalid);
        vectors.push({
          schemaVersion: 1,
          id: vectorId(
            manifest.version,
            operation,
            "invalid-parameter",
            `${parameter.location}-${parameter.cliName}`,
          ),
          version: manifest.version,
          kind: "invalid-parameter",
          operationKey: operation.key,
          operationId: operation.operationId,
          command: operation.command,
          input: invalidInput,
          expected: {
            reachesServer: false,
            exit: "nonzero",
            errorContains: parameter.cliName,
          },
          covers: [`invalid-parameter:${parameter.location}:${parameter.name}`],
        });
      }
    }

    for (const branch of operation.requestBody?.branches ?? []) {
      const input = minimalInput(operation, branch);
      input.body = clone(branch.sample);
      vectors.push(
        requestVector(
          manifest.version,
          operation,
          "body-branch",
          input,
          [
            `request-body:${operation.requestBody?.contentType}`,
            `body-branch:${branch.id}`,
          ],
          branch.id,
        ),
      );
      for (const field of branch.requiredFields) {
        if (!input.body || Array.isArray(input.body) || typeof input.body !== "object") {
          continue;
        }
        const missing = clone(input);
        if (
          missing.body &&
          !Array.isArray(missing.body) &&
          typeof missing.body === "object"
        ) {
          delete missing.body[field];
        }
        vectors.push({
          schemaVersion: 1,
          id: vectorId(
            manifest.version,
            operation,
            "missing-required-body-field",
            `${branch.id}-${kebabSafe(field)}`,
          ),
          version: manifest.version,
          kind: "missing-required-body-field",
          operationKey: operation.key,
          operationId: operation.operationId,
          command: operation.command,
          input: missing,
          expected: {
            reachesServer: false,
            exit: "nonzero",
            errorContains: field,
          },
          covers: [`required-body-field:${branch.id}:${field}`],
        });
      }
    }

    for (const response of operation.responses) {
      const input = minimalInput(operation);
      vectors.push({
        schemaVersion: 1,
        id: vectorId(
          manifest.version,
          operation,
          "response",
          response.key.toLowerCase(),
        ),
        version: manifest.version,
        kind: "response",
        operationKey: operation.key,
        operationId: operation.operationId,
        command: operation.command,
        input,
        expectedRequest: requestWithAuth(operation, input),
        response,
        expected: {
          reachesServer: true,
          exit:
            response.status >= 200 && response.status < 300 ? "zero" : "nonzero",
        },
        covers: [`response:${response.key}`],
      });
    }
  }
  const ids = new Set<string>();
  for (const vector of vectors) {
    if (ids.has(vector.id)) throw new Error(`Duplicate vector id: ${vector.id}`);
    ids.add(vector.id);
  }
  return vectors;
}

function kebabSafe(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function coverageReport(
  compiled: CompiledSpec,
  vectors: ConformanceVector[],
): CoverageReport {
  const operations = compiled.manifest.operations;
  const vectorsByKind: Record<string, number> = {};
  for (const vector of vectors) {
    vectorsByKind[vector.kind] = (vectorsByKind[vector.kind] ?? 0) + 1;
  }
  const parameters = operations.flatMap((operation) => operation.parameters);
  const bodies = operations.flatMap((operation) =>
    operation.requestBody ? [operation.requestBody] : [],
  );
  const branches = bodies.flatMap((body) => body.branches);
  return {
    schemaVersion: 1,
    version: compiled.manifest.version,
    sourceSha256: compiled.manifest.source.sha256,
    counts: {
      paths: compiled.pathCount,
      operations: operations.length,
      parameters: parameters.length,
      requiredParameters: parameters.filter((parameter) => parameter.required).length,
      requestBodies: bodies.length,
      bodyBranches: branches.length,
      requiredBodyFields: branches.reduce(
        (total, branch) => total + branch.requiredFields.length,
        0,
      ),
      responses: operations.reduce(
        (total, operation) => total + operation.responses.length,
        0,
      ),
      vectors: vectors.length,
    },
    vectorsByKind: Object.fromEntries(
      Object.entries(vectorsByKind).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    unsupported: compiled.unsupported,
    sourceIssues: compiled.sourceIssues,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl(vectors: ConformanceVector[]): string {
  return `${vectors.map((vector) => JSON.stringify(vector)).join("\n")}\n`;
}

export async function generateCorpus(entry: CatalogEntry): Promise<GeneratedCorpus> {
  const raw = await readVerifiedSpec(entry);
  const compiled = compileOpenApi(
    entry,
    raw,
    "web/public/generated/api/openapi.yml",
  );
  const vectors = generateVectors(compiled);
  const coverage = coverageReport(compiled, vectors);
  return {
    compiled,
    vectors,
    coverage,
    files: {
      manifest: json(compiled.manifest),
      vectors: jsonl(vectors),
      coverage: json(coverage),
    },
  };
}

export async function writeCorpus(entry: CatalogEntry): Promise<GeneratedCorpus> {
  const corpus = await generateCorpus(entry);
  const directory = generatedDir(entry);
  await mkdir(directory, { recursive: true });
  await Bun.write(resolve(directory, "manifest.json"), corpus.files.manifest);
  await Bun.write(resolve(directory, "vectors.jsonl"), corpus.files.vectors);
  await Bun.write(resolve(directory, "coverage.json"), corpus.files.coverage);
  return corpus;
}

export async function checkCorpus(entry: CatalogEntry): Promise<GeneratedCorpus> {
  const corpus = await generateCorpus(entry);
  const directory = generatedDir(entry);
  const expected: Array<[string, string]> = [
    ["manifest.json", corpus.files.manifest],
    ["vectors.jsonl", corpus.files.vectors],
    ["coverage.json", corpus.files.coverage],
  ];
  for (const [filename, content] of expected) {
    const path = resolve(directory, filename);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`Missing generated file: ${path}`);
    if ((await file.text()) !== content) {
      throw new Error(`Generated corpus is stale: ${path}`);
    }
  }
  return corpus;
}

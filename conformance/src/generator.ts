import { readVerifiedSpec } from "./catalog";
import { compileOpenApi, type CompiledSpec } from "./openapi";
import { expectedRequest } from "./serialize";
import type {
  CatalogEntry,
  ConformanceVector,
  OperationContract,
  ResponseContract,
  SemanticInput,
} from "./types";

export interface GeneratedCorpus {
  compiled: CompiledSpec;
  vectors: ConformanceVector[];
}

function targetForParameter(
  input: SemanticInput,
  location: OperationContract["parameters"][number]["location"],
) {
  if (location === "path") return input.path;
  if (location === "query") return input.query;
  if (location === "header") return input.headers;
  return input.cookies;
}

function minimalInput(operation: OperationContract): SemanticInput {
  const input: SemanticInput = {
    path: {},
    query: {},
    headers: {},
    cookies: {},
  };
  for (const parameter of operation.parameters) {
    if (parameter.required) {
      targetForParameter(input, parameter.location)[parameter.name] =
        structuredClone(parameter.sample);
    }
  }
  if (operation.requestBody?.required) {
    input.body = structuredClone(operation.requestBody.sample);
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

export function generateVectors(compiled: CompiledSpec): ConformanceVector[] {
  const vectors = compiled.manifest.operations.map((operation) => {
    const input = minimalInput(operation);
    return {
      id: `${compiled.manifest.version}:${operation.operationId}:minimal-request`,
      version: compiled.manifest.version,
      operationKey: operation.key,
      operationId: operation.operationId,
      command: operation.command,
      input,
      expectedRequest: requestWithAuth(operation, input),
      response: successResponse(operation),
    } satisfies ConformanceVector;
  });
  const ids = new Set(vectors.map((vector) => vector.id));
  if (ids.size !== vectors.length) {
    throw new Error(`${compiled.manifest.version}: duplicate operationId`);
  }
  return vectors;
}

export async function generateCorpus(entry: CatalogEntry): Promise<GeneratedCorpus> {
  const raw = await readVerifiedSpec(entry);
  const compiled = compileOpenApi(entry, raw);
  return { compiled, vectors: generateVectors(compiled) };
}

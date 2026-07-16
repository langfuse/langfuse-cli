export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonSchema = Record<string, any>;
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "TRACE";

export interface CatalogEntry {
  version: string;
  ref: string;
  commit: string;
  sha256: string;
  support: string;
  knownIssues?: string[];
}

export interface Catalog {
  schemaVersion: 1;
  repository: string;
  specPath: string;
  versions: CatalogEntry[];
}

export interface CommandName {
  resource: string;
  action: string;
  canonicalAction: string;
  aliasOf?: string;
}

export interface ParameterContract {
  location: "path" | "query" | "header" | "cookie";
  name: string;
  cliName: string;
  required: boolean;
  style: string;
  explode: boolean;
  schema: JsonSchema;
  sample: JsonValue;
}

export interface BodyBranch {
  id: string;
  requiredFields: string[];
  schema: JsonSchema;
  sample: JsonValue;
}

export interface RequestBodyContract {
  required: boolean;
  contentType: string;
  branches: BodyBranch[];
}

export interface ResponseContract {
  key: string;
  status: number;
  description?: string;
  contentType?: string;
  sample?: JsonValue;
}

export interface OperationContract {
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
  command: CommandName;
  pathParameterOrder: string[];
  parameters: ParameterContract[];
  requestBody?: RequestBodyContract;
  responses: ResponseContract[];
}

export interface Manifest {
  schemaVersion: 1;
  version: string;
  source: {
    ref: string;
    commit: string;
    sha256: string;
    path: string;
  };
  openapi: string;
  generatedAt: "deterministic";
  operations: OperationContract[];
}

export interface SemanticInput {
  path: Record<string, JsonValue>;
  query: Record<string, JsonValue>;
  headers: Record<string, JsonValue>;
  cookies: Record<string, JsonValue>;
  body?: JsonValue;
}

export interface ExpectedRequest {
  method: HttpMethod;
  pathname: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body?: JsonValue;
}

export type VectorKind =
  | "discovery"
  | "help"
  | "minimal-request"
  | "parameter-serialization"
  | "body-branch"
  | "missing-required-parameter"
  | "invalid-parameter"
  | "missing-required-body-field"
  | "response";

export interface ConformanceVector {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: VectorKind;
  operationKey?: string;
  operationId?: string;
  command?: CommandName;
  input?: SemanticInput;
  expectedRequest?: ExpectedRequest;
  response?: ResponseContract;
  expected: {
    reachesServer: boolean;
    exit: "zero" | "nonzero";
    errorContains?: string;
  };
  covers: string[];
}

export interface CoverageReport {
  schemaVersion: 1;
  version: string;
  sourceSha256: string;
  counts: {
    paths: number;
    operations: number;
    parameters: number;
    requiredParameters: number;
    requestBodies: number;
    bodyBranches: number;
    requiredBodyFields: number;
    responses: number;
    vectors: number;
  };
  vectorsByKind: Record<string, number>;
  unsupported: string[];
  sourceIssues: string[];
}

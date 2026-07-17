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
  sample: JsonValue;
}

export interface RequestBodyContract {
  required: boolean;
  contentType: string;
  sample: JsonValue;
}

export interface ResponseContract {
  key: string;
  status: number;
  contentType?: string;
  sample?: JsonValue;
}

export interface OperationContract {
  key: string;
  operationId: string;
  method: HttpMethod;
  path: string;
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
  version: string;
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

export interface ConformanceVector {
  id: string;
  version: string;
  operationKey: string;
  operationId: string;
  command: CommandName;
  input: SemanticInput;
  expectedRequest: ExpectedRequest;
  response: ResponseContract;
}

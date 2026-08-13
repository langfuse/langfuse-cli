export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "TRACE";

export type ValueKind =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface CommandName {
  resource: string;
  action: string;
  canonicalAction: string;
  aliasOf?: string;
}

export interface ApiParameter {
  location: "path" | "query" | "header" | "cookie";
  name: string;
  cliName: string;
  required: boolean;
  style: string;
  explode: boolean;
  kind: ValueKind;
  itemKind?: ValueKind;
}

export interface ApiBodyField {
  name: string;
  required: boolean;
  kind: ValueKind;
  itemKind?: ValueKind;
  description?: string;
}

export interface ApiRequestBody {
  required: boolean;
  contentType: string;
  legacyFieldFlags: boolean;
  fields: ApiBodyField[];
}

export interface ApiOperation {
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
  parameters: ApiParameter[];
  requestBody?: ApiRequestBody;
  summary?: string;
  description?: string;
}

export interface ApiContract {
  schemaVersion: 1;
  apiVersion: string;
  sourceSha256: string;
  operations: ApiOperation[];
}

export interface ApiContractCatalogEntry {
  version: string;
  sourceSha256: string;
}

export interface ApiContractCatalog {
  schemaVersion: 1;
  latest: string;
  versions: ApiContractCatalogEntry[];
}

export interface ApiCallInput {
  path: Record<string, JsonValue>;
  query: Record<string, JsonValue>;
  headers: Record<string, JsonValue>;
  cookies: Record<string, JsonValue>;
  body?: JsonValue;
}

export interface ApiClientConfig {
  host: string;
  publicKey?: string;
  secretKey?: string;
  timeoutMs: number;
}

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: JsonValue | string | null;
  ok: boolean;
}

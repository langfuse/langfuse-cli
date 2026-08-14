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
  aliases?: CommandAlias[];
}

export interface CommandAlias {
  resource: string;
  action: string;
  source: "path" | "tag" | "version";
}

export interface ApiParameter {
  location: "path" | "query" | "header" | "cookie";
  name: string;
  cliName: string;
  cliAliases?: string[];
  required: boolean;
  style: string;
  explode: boolean;
  kind: ValueKind;
  itemKind?: ValueKind;
  enum?: Array<string | number>;
  description?: string;
}

export interface ParameterFlagAlias {
  // Path parameters are positional at the CLI and can never carry flag
  // aliases; the compiler also rejects "path" at runtime since overrides.json
  // bypasses the type system.
  location: "query" | "header" | "cookie";
  parameter: string;
  flag: string;
}

export interface ContractOverrides {
  schemaVersion: 1;
  parameterFlagAliases: Record<string, ParameterFlagAlias[]>;
  // operationId -> body field wire name -> CLI flag. Used to resolve flag
  // collisions the compiler rejects (e.g. a field kebab-casing onto a
  // reserved/global flag). Wire names in the request are never affected.
  bodyFieldFlags: Record<string, Record<string, string>>;
  commandOverrides: Record<
    string,
    Record<string, { resource?: string; action?: string }>
  >;
}

export interface ApiBodyField {
  name: string;
  cliName: string;
  required: boolean;
  kind: ValueKind;
  itemKind?: ValueKind;
  enum?: Array<string | number>;
  description?: string;
}

export interface ApiRequestBody {
  required: boolean;
  contentType: string;
  legacyFieldFlags: boolean;
  // Top-level oneOf/anyOf body: fields are merged across the union variants.
  union?: true;
  fields: ApiBodyField[];
}

export interface ApiOperation {
  key: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  deprecated?: true;
  pagination?: "page" | "cursor";
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

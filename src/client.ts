import packageJson from "../package.json";

import type {
  ApiCallInput,
  ApiClientConfig,
  ApiOperation,
  ApiResult,
  JsonValue,
} from "./contracts/types";

export interface PreparedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
}

const USER_AGENT = `langfuse-cli/${packageJson.version}`;

function primitive(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function pathValue(value: JsonValue, style: string, explode: boolean): string {
  if (style !== "simple") throw new Error(`Unsupported path style: ${style}`);
  if (Array.isArray(value)) return value.map(primitive).join(",");
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return explode
      ? entries.map(([key, item]) => `${key}=${primitive(item)}`).join(",")
      : entries.flatMap(([key, item]) => [key, primitive(item)]).join(",");
  }
  return primitive(value);
}

function queryValues(
  name: string,
  value: JsonValue,
  style: string,
  explode: boolean,
): Array<[string, string]> {
  if (style !== "form") throw new Error(`Unsupported query style: ${style}`);
  if (Array.isArray(value)) {
    return explode
      ? value.map((item) => [name, primitive(item)])
      : [[name, value.map(primitive).join(",")]];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return explode
      ? entries.map(([key, item]) => [key, primitive(item)])
      : [[name, entries.flatMap(([key, item]) => [key, primitive(item)]).join(",")]];
  }
  return [[name, primitive(value)]];
}

function encodePathComponent(value: string): string {
  return encodeURIComponent(value);
}

export function prepareRequest(
  config: ApiClientConfig,
  operation: ApiOperation,
  input: ApiCallInput,
): PreparedRequest {
  let pathname = operation.path;
  const headers = new Headers();
  const cookies: string[] = [];
  const query: Array<[string, string]> = [];
  for (const parameter of operation.parameters) {
    const source =
      parameter.location === "path"
        ? input.path
        : parameter.location === "query"
          ? input.query
          : parameter.location === "header"
            ? input.headers
            : input.cookies;
    const value = source[parameter.name];
    if (value === undefined) continue;
    if (parameter.location === "path") {
      pathname = pathname.replace(
        `{${parameter.name}}`,
        encodePathComponent(pathValue(value, parameter.style, parameter.explode)),
      );
    } else if (parameter.location === "query") {
      query.push(
        ...queryValues(
          parameter.name,
          value,
          parameter.style,
          parameter.explode,
        ),
      );
    } else if (parameter.location === "header") {
      headers.set(parameter.name, primitive(value));
    } else {
      cookies.push(`${parameter.name}=${primitive(value)}`);
    }
  }
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  if (operation.auth.required && operation.auth.schemes.includes("BasicAuth")) {
    if (!config.publicKey || !config.secretKey) {
      throw new Error(
        "This operation requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
      );
    }
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
    );
  }
  let body: string | undefined;
  if (input.body !== undefined) {
    if (!operation.requestBody) {
      throw new Error(`${operation.operationId} does not accept a request body`);
    }
    headers.set("content-type", operation.requestBody.contentType);
    body = JSON.stringify(input.body);
  }
  headers.set("accept", "application/json");
  headers.set("user-agent", USER_AGENT);
  const host = config.host.endsWith("/") ? config.host : `${config.host}/`;
  const url = new URL(pathname.replace(/^\//, ""), host);
  for (const [name, value] of query) url.searchParams.append(name, value);
  return {
    url,
    method: operation.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

async function responseBody(response: Response): Promise<JsonValue | string | null> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || contentType.includes("+json")) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

export function createApiClient(config: ApiClientConfig) {
  return {
    prepare(operation: ApiOperation, input: ApiCallInput): PreparedRequest {
      return prepareRequest(config, operation, input);
    },

    async call(operation: ApiOperation, input: ApiCallInput): Promise<ApiResult> {
      const prepared = prepareRequest(config, operation, input);
      const response = await fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await responseBody(response),
        ok: response.ok,
      };
    },
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderCurl(
  prepared: PreparedRequest,
  options: { showSecrets: boolean },
): string {
  const parts = ["curl", "--request", prepared.method, shellQuote(prepared.url.href)];
  for (const [name, value] of prepared.headers.entries()) {
    const rendered =
      name.toLowerCase() === "authorization" && !options.showSecrets
        ? "Basic <redacted>"
        : value;
    parts.push("--header", shellQuote(`${name}: ${rendered}`));
  }
  if (prepared.body !== undefined) {
    parts.push("--data", shellQuote(prepared.body));
  }
  return parts.join(" ");
}

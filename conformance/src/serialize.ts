import type {
  ExpectedRequest,
  JsonValue,
  OperationContract,
  SemanticInput,
} from "./types";

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

export function expectedRequest(
  operation: OperationContract,
  input: SemanticInput,
): ExpectedRequest {
  let pathname = operation.path;
  const query: Array<[string, string]> = [];
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
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
        encodeURIComponent(pathValue(value, parameter.style, parameter.explode)),
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
      headers[parameter.name.toLowerCase()] = primitive(value);
    } else {
      cookies.push(`${parameter.name}=${primitive(value)}`);
    }
  }
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  if (input.body !== undefined && operation.requestBody) {
    headers["content-type"] = operation.requestBody.contentType;
  }
  return {
    method: operation.method,
    pathname,
    query,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
}

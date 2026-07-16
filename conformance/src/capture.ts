import type { ExpectedRequest, JsonValue, ResponseContract } from "./types";

export interface CapturedRequest {
  method: string;
  pathname: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body?: JsonValue | string;
}

function responseBody(response: ResponseContract): BodyInit | null {
  if (response.status === 204 || response.status === 205 || response.sample === undefined) {
    return null;
  }
  if (response.contentType?.includes("json")) return JSON.stringify(response.sample);
  return typeof response.sample === "string"
    ? response.sample
    : JSON.stringify(response.sample);
}

export class CaptureServer {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly requests: CapturedRequest[] = [];
  #response: ResponseContract = {
    key: "200",
    status: 200,
    contentType: "application/json",
    sample: { ok: true },
  };

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const rawBody = await request.text();
        let body: JsonValue | string | undefined;
        if (rawBody) {
          if ((request.headers.get("content-type") ?? "").includes("json")) {
            try {
              body = JSON.parse(rawBody);
            } catch {
              body = rawBody;
            }
          } else {
            body = rawBody;
          }
        }
        this.requests.push({
          method: request.method,
          pathname: url.pathname,
          query: [...url.searchParams.entries()],
          headers: Object.fromEntries(
            [...request.headers.entries()].map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
          ...(body !== undefined ? { body } : {}),
        });
        const headers = new Headers();
        if (this.#response.contentType && responseBody(this.#response) !== null) {
          headers.set("content-type", this.#response.contentType);
        }
        return new Response(responseBody(this.#response), {
          status: this.#response.status,
          headers,
        });
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  arm(response?: ResponseContract): number {
    this.#response = response ?? {
      key: "200",
      status: 200,
      contentType: "application/json",
      sample: { ok: true },
    };
    return this.requests.length;
  }

  stop(): void {
    this.server.stop(true);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sortedQuery(query: Array<[string, string]>): Array<[string, string]> {
  return [...query].sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName.localeCompare(rightName);
    return leftValue.localeCompare(rightValue);
  });
}

export function requestDiff(
  expected: ExpectedRequest,
  actual: CapturedRequest,
): string[] {
  const differences: string[] = [];
  if (actual.method !== expected.method) {
    differences.push(`method: expected ${expected.method}, got ${actual.method}`);
  }
  if (actual.pathname !== expected.pathname) {
    differences.push(
      `pathname: expected ${expected.pathname}, got ${actual.pathname}`,
    );
  }
  if (!sameJson(sortedQuery(actual.query), sortedQuery(expected.query))) {
    differences.push(
      `query: expected ${JSON.stringify(expected.query)}, got ${JSON.stringify(actual.query)}`,
    );
  }
  for (const [name, value] of Object.entries(expected.headers)) {
    if (actual.headers[name.toLowerCase()] !== value) {
      differences.push(
        `header ${name}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual.headers[name.toLowerCase()])}`,
      );
    }
  }
  if (!sameJson(expected.body, actual.body)) {
    differences.push(
      `body: expected ${JSON.stringify(expected.body)}, got ${JSON.stringify(actual.body)}`,
    );
  }
  return differences;
}

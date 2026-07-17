import type {
  ConformanceVector,
  JsonValue,
  Manifest,
  OperationContract,
  ParameterContract,
} from "./types";

export type AdapterName = "specli-v0" | "contract-v1";

interface Policy {
  schemaVersion: 1;
  commandPrefix: string[];
  auth: { publicKey: string; secretKey: string };
  profiles: Record<
    AdapterName,
    {
      bodyMode: "field-flags" | "body-json";
      queryAliases: Record<string, string>;
    }
  >;
}

function optionValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function addFlag(args: string[], flag: string, value: JsonValue): void {
  if (typeof value === "boolean") {
    if (value) args.push(flag);
    else args.push(flag, "false");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) args.push(flag, optionValue(item));
    return;
  }
  args.push(flag, optionValue(value));
}

function flattenBody(
  value: JsonValue,
  prefix: string[] = [],
): Array<{ path: string[]; value: JsonValue }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: prefix, value }];
  }
  return Object.entries(value).flatMap(([name, child]) =>
    flattenBody(child, [...prefix, name]),
  );
}

function parameterValue(
  vector: ConformanceVector,
  parameter: ParameterContract,
): JsonValue | undefined {
  const input = vector.input;
  if (parameter.location === "path") return input.path[parameter.name];
  if (parameter.location === "query") return input.query[parameter.name];
  if (parameter.location === "header") return input.headers[parameter.name];
  return input.cookies[parameter.name];
}

export async function loadPolicy(path: string): Promise<Policy> {
  const policy = (await Bun.file(path).json()) as Policy;
  if (policy.schemaVersion !== 1) throw new Error(`Unsupported policy: ${path}`);
  return policy;
}

export function operationForVector(
  manifest: Manifest,
  vector: ConformanceVector,
): OperationContract {
  const operation = manifest.operations.find(
    (candidate) => candidate.key === vector.operationKey,
  );
  if (!operation) throw new Error(`${vector.id}: operation not found`);
  return operation;
}

export function invocationArgs(params: {
  adapter: AdapterName;
  policy: Policy;
  vector: ConformanceVector;
  manifest: Manifest;
  host: string;
}): string[] {
  const { adapter, policy, vector, manifest, host } = params;
  const profile = policy.profiles[adapter];
  const globals = [
    "--host",
    host,
    "--public-key",
    policy.auth.publicKey,
    "--secret-key",
    policy.auth.secretKey,
  ];
  const operation = operationForVector(manifest, vector);
  const args = [
    ...globals,
    ...policy.commandPrefix,
    vector.command.resource,
    vector.command.action,
  ];
  for (const name of operation.pathParameterOrder) {
    const parameter = operation.parameters.find(
      (candidate) => candidate.location === "path" && candidate.name === name,
    );
    if (!parameter) continue;
    const value = parameterValue(vector, parameter);
    if (value !== undefined) args.push(optionValue(value));
  }
  for (const parameter of operation.parameters) {
    if (parameter.location === "path") continue;
    const value = parameterValue(vector, parameter);
    if (value === undefined) continue;
    const aliasKey = `${operation.operationId}:${parameter.name}`;
    const flagName = profile.queryAliases[aliasKey] ?? parameter.cliName;
    addFlag(args, `--${flagName}`, value);
  }
  if (vector.input.body !== undefined) {
    if (profile.bodyMode === "body-json") {
      args.push("--body-json", JSON.stringify(vector.input.body));
    } else {
      for (const field of flattenBody(vector.input.body)) {
        if (field.path.length === 0) continue;
        addFlag(args, `--${field.path.join(".")}`, field.value);
      }
    }
  }
  args.push("--json");
  return args;
}

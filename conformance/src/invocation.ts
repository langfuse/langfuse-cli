import type {
  ConformanceVector,
  JsonValue,
  Manifest,
  OperationContract,
  ParameterContract,
} from "./types";

const PUBLIC_KEY = "conformance-public-key";
const SECRET_KEY = "conformance-secret-key";

function optionValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function addFlag(args: string[], flag: string, value: JsonValue): void {
  if (typeof value === "boolean") {
    args.push(flag, value ? "true" : "false");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) args.push(flag, optionValue(item));
    return;
  }
  args.push(flag, optionValue(value));
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
  vector: ConformanceVector;
  manifest: Manifest;
  host: string;
}): string[] {
  const { vector, manifest, host } = params;
  const operation = operationForVector(manifest, vector);
  const args = [
    "--host",
    host,
    "--public-key",
    PUBLIC_KEY,
    "--secret-key",
    SECRET_KEY,
    "api",
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
    if (value !== undefined) addFlag(args, `--${parameter.cliName}`, value);
  }
  if (vector.input.body !== undefined) {
    args.push("--body-json", JSON.stringify(vector.input.body));
  }
  args.push("--json");
  return args;
}

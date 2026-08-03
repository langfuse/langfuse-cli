import { readFileSync } from "node:fs";

const DEFAULT_HOST = "https://cloud.langfuse.com";
const OPENAPI_FILE_URL = new URL("../openapi.yml", import.meta.url);
const LANGFUSE_SKILL_URL =
  "https://raw.githubusercontent.com/langfuse/skills/main/skills/langfuse/SKILL.md";
const GET_SKILL_FETCH_TIMEOUT_MS = 5000;
const LANGFUSE_FLAGS = new Set([
  "--public-key",
  "--secret-key",
  "--host",
  "--env",
]);
const LANGFUSE_BOOL_FLAGS = new Set(["--refetch-api-spec"]);

function loadEnvFile(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

type MainFn = (
  argv: string[],
  options?: { cliName?: string; auth?: string; embeddedSpecText?: string },
) => Promise<void>;

async function loadMain(): Promise<MainFn> {
  const specliEntry = import.meta.resolve("specli");
  const cliMainUrl = new URL("cli/main.js", specliEntry);
  const mod = await import(cliMainUrl.href);
  return mod.main;
}

async function getSpecText(params: {
  refetch: boolean;
  host: string;
}): Promise<string> {
  if (params.refetch) {
    const specUrl = `${params.host}/generated/api/openapi.yml`;
    return fetchText(specUrl, "spec");
  }

  // Use bundled spec
  return readFileSync(OPENAPI_FILE_URL, "utf-8");
}

async function fetchText(
  url: string,
  label: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const resp = await fetch(url, {
    signal:
      typeof options?.timeoutMs === "number"
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined,
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch ${label} from ${url}: ${resp.status} ${resp.statusText}`,
    );
  }
  return resp.text();
}

async function getSkillText(): Promise<string> {
  return fetchText(LANGFUSE_SKILL_URL, "skill", {
    timeoutMs: GET_SKILL_FETCH_TIMEOUT_MS,
  });
}

function printGetSkillFetchError(err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);

  process.stderr.write(`Failed to fetch the latest Langfuse skill from GitHub.
This environment may block direct GitHub access.

Download the skill manually from:
  ${LANGFUSE_SKILL_URL}

Then add the downloaded SKILL.md to your agent context manually.

Original error: ${reason}
`);
}

export async function run(argv: string[]): Promise<void> {
  const extracted: Record<string, string> = {};
  const boolFlags: Record<string, boolean> = {};
  const passthrough: string[] = [argv[0], argv[1]];

  let i = 2;
  while (i < argv.length) {
    if (LANGFUSE_FLAGS.has(argv[i]) && i + 1 < argv.length) {
      const key = argv[i].replace(/^--/, "");
      extracted[key] = argv[i + 1];
      i += 2;
    } else if (LANGFUSE_BOOL_FLAGS.has(argv[i])) {
      const key = argv[i].replace(/^--/, "");
      boolFlags[key] = true;
      i++;
    } else {
      passthrough.push(argv[i]);
      i++;
    }
  }

  if (extracted["env"]) {
    loadEnvFile(extracted["env"]);
  }

  const publicKey =
    extracted["public-key"] ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey =
    extracted["secret-key"] ?? process.env.LANGFUSE_SECRET_KEY;
  const host = (
    extracted["host"] ??
    process.env.LANGFUSE_BASE_URL ??
    process.env.LANGFUSE_HOST ??
    DEFAULT_HOST
  ).replace(/\/$/, "");

  // First positional arg determines the subcommand
  const subcommand = passthrough[2];

  if (subcommand === "api") {
    passthrough.splice(2, 1);
    return runApi({ passthrough, boolFlags, publicKey, secretKey, host });
  }

  if (subcommand === "get-skill") {
    try {
      process.stdout.write(await getSkillText());
    } catch (err) {
      printGetSkillFetchError(err);
      process.exitCode = 1;
    }
    return;
  }

  // Show help for anything else (no args, --help, -h, unknown command)
  printHelp();
}

function printHelp(): void {
  console.log(`langfuse-cli — Interact with Langfuse from the command line

Usage: langfuse [options] <command>

Commands:
  api                     Interact with the Langfuse REST API
  get-skill               Print the latest Langfuse skill from GitHub

Options:
  --public-key <key>      Langfuse public key (or LANGFUSE_PUBLIC_KEY)
  --secret-key <key>      Langfuse secret key (or LANGFUSE_SECRET_KEY)
  --host <url>            Langfuse host (or LANGFUSE_HOST/LANGFUSE_BASE_URL, default: ${DEFAULT_HOST})
  --env <path>       Load env vars from file
  --refetch-api-spec      Fetch latest API spec instead of bundled

Examples:
  langfuse api __schema                              List all available resources
  langfuse api <resource> --help                     Show actions for a resource
  langfuse api prompts list                          List prompts
  langfuse api prompts get --name my-prompt          Get a prompt
  langfuse api datasets create --name my-dataset     Create a dataset
  langfuse api dataset-items list --dataset-name <id> List dataset items`);
}

function printApiHelp(resources: string[]): void {
  const sorted = [...resources].sort();
  console.log(`Usage: langfuse api [options] <resource> <action>

Langfuse API Resources:
${sorted.map((r) => `  ${r}`).join("\n")}

Commands:
  __schema                Show API spec metadata
  <resource> --help       Show actions for a resource
  <resource> <action> --help  Show options for an action

Options:
  --json                  Output as JSON
  --curl                  Preview curl command without executing
  -h, --help              Show help

Workflow:
  1) langfuse api __schema
  2) langfuse api <resource> --help
  3) langfuse api <resource> <action> --help
  4) langfuse api <resource> <action> [options]`);
}

async function getResources(specText: string): Promise<string[]> {
  // Run specli's __schema --json to get the canonical resource list
  const main = await loadMain();
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: any) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await main(["node", "langfuse", "__schema", "--json"], {
      cliName: "langfuse api",
      auth: "BasicAuth",
      embeddedSpecText: specText,
    });
  } finally {
    process.stdout.write = origWrite;
  }
  const output = JSON.parse(chunks.join(""));
  return (output.data?.resources ?? []).map((r: any) => r.name);
}

async function runApi(params: {
  passthrough: string[];
  boolFlags: Record<string, boolean>;
  publicKey: string | undefined;
  secretKey: string | undefined;
  host: string;
}): Promise<void> {
  const { passthrough, boolFlags, publicKey, secretKey, host } = params;

  const specText = await getSpecText({
    refetch: boolFlags["refetch-api-spec"] ?? false,
    host,
  });

  // Intercept help: no args, --help, or -h
  const args = passthrough.slice(2);
  if (
    args.length === 0 ||
    (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
  ) {
    printApiHelp(await getResources(specText));
    return;
  }

  const specliArgv = [...passthrough];
  const inject: string[] = ["--server", host];
  if (publicKey) inject.push("--username", publicKey);
  if (secretKey) inject.push("--password", secretKey);
  specliArgv.splice(2, 0, ...inject);

  const main = await loadMain();
  await main(specliArgv, {
    cliName: "langfuse api",
    auth: "BasicAuth",
    embeddedSpecText: specText,
  });
}

import { join } from "node:path";
import { parseArgs } from "node:util";
import { TRACE_MANIFEST_DIR_RELATIVE } from "./shared/constants";
import { fileExists } from "./shared/fs";
import { resolveRepoRoot } from "./shared/git";
import { readTraceManifests } from "./shared/manifests";

interface TracesOptions {
  limit: number;
  json: boolean;
}

function printTracesHelp(): void {
  console.log(`Usage: langfuse traces [options]

List trace manifests for the current repository.

Options:
  -h, --help              Show this help
  --limit <n>             Number of traces to print (default: 20)
  --json                  Output manifests as JSON
`);
}

function parseLimit(value: string | undefined): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit value: ${value}`);
  }

  return parsed;
}

function parseTracesOptions(args: string[]): TracesOptions {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      limit: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printTracesHelp();
    process.exitCode = 0;
  }

  return {
    limit: parseLimit(values.limit),
    json: values.json ?? false,
  };
}

function trimMessage(message: string): string {
  const maxLength = 90;
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 3)}...`;
}

export async function runTraces(args: string[]): Promise<void> {
  const options = parseTracesOptions(args);
  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  const repo = await resolveRepoRoot(process.cwd());
  const tracesDir = join(repo.repoRoot, TRACE_MANIFEST_DIR_RELATIVE);

  const tracesDirExists = await fileExists(tracesDir);
  if (!tracesDirExists) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("No trace manifests found. Run `langfuse enable` and make a commit via Claude Code.");
    return;
  }

  const manifests = await readTraceManifests(tracesDir);
  if (manifests.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("No trace manifests found. Run `langfuse enable` and make a commit via Claude Code.");
    return;
  }

  const selected = manifests.slice(0, options.limit);

  if (options.json) {
    console.log(JSON.stringify(selected.map((item) => item.manifest), null, 2));
    return;
  }

  for (const item of selected) {
    const sessionId = item.manifest.langfuse.session_id;
    const commitSha = item.manifest.git.commit_sha.slice(0, 8);
    const branch = item.manifest.git.branch || "unknown";
    const message = trimMessage(item.manifest.git.commit_message || "");
    const traceUrl = item.manifest.langfuse.trace_url || "(missing trace URL)";

    console.log(`${sessionId}  ${commitSha}  ${branch}  ${message}`);
    console.log(traceUrl);
  }
}

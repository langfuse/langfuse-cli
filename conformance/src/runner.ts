import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  invocationArgs,
  loadPolicy,
  type AdapterName,
} from "./adapters";
import { CaptureServer, requestDiff, sameJson } from "./capture";
import { POLICY_PATH, REPOSITORY_ROOT, readVerifiedSpec } from "./catalog";
import { compileApiContract } from "../../src/contracts/compiler";
import type {
  CatalogEntry,
  ConformanceVector,
  Manifest,
} from "./types";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  entry: CatalogEntry;
  manifest: Manifest;
  vectors: ConformanceVector[];
  adapter: AdapterName;
  command?: string[];
  currentCli?: boolean;
  timeoutMs?: number;
  failFast?: boolean;
  quiet?: boolean;
}

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  process: ProcessResult;
}

async function spawn(
  command: string[],
  args: string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const process = Bun.spawn([...command, ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...processEnv(),
        LANGFUSE_PUBLIC_KEY: undefined,
        LANGFUSE_SECRET_KEY: undefined,
        LANGFUSE_HOST: undefined,
        LANGFUSE_BASE_URL: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const stdoutPromise = new Response(process.stdout).text();
    const stderrPromise = new Response(process.stderr).text();
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      stdoutPromise,
      stderrPromise,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 124,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function processEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, value]),
  );
}

async function currentCliCommand(entry: CatalogEntry): Promise<{
  command: string[];
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "langfuse-cli-conformance-"));
  const dist = resolve(directory, "dist");
  const bin = resolve(directory, "bin");
  await mkdir(dist, { recursive: true });
  await mkdir(bin, { recursive: true });
  const build = Bun.spawn(
    [
      "bun",
      "build",
      resolve(REPOSITORY_ROOT, "src/cli.ts"),
      "--outfile",
      resolve(dist, "cli.js"),
      "--target",
      "bun",
      "--format",
      "esm",
    ],
    { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const buildOut = new Response(build.stdout).text();
  const buildErr = new Response(build.stderr).text();
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    buildOut,
    buildErr,
  ]);
  if (code !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Current CLI build failed:\n${stdout}${stderr}`);
  }
  const raw = await readVerifiedSpec(entry);
  const contracts = resolve(dist, "contracts");
  await mkdir(contracts, { recursive: true });
  await Bun.write(
    resolve(contracts, `${entry.version}.json`),
    `${JSON.stringify(compileApiContract(entry, raw))}\n`,
  );
  await Bun.write(
    resolve(contracts, "catalog.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      latest: entry.version,
      versions: [{ version: entry.version, sourceSha256: entry.sha256 }],
    })}\n`,
  );
  await Bun.write(
    resolve(bin, "langfuse.mjs"),
    await Bun.file(resolve(REPOSITORY_ROOT, "bin/langfuse.mjs")).text(),
  );
  return {
    command: ["bun", resolve(bin, "langfuse.mjs")],
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function parseJson(stdout: string): any | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export async function runConformance(options: RunOptions): Promise<CaseResult[]> {
  if (options.currentCli && options.adapter !== "specli-v0") {
    throw new Error("The current CLI must use the specli-v0 adapter");
  }
  const materialized = options.currentCli
    ? await currentCliCommand(options.entry)
    : undefined;
  const command = materialized?.command ?? options.command;
  if (!command?.length) throw new Error("Missing implementation command after --");
  const policy = await loadPolicy(POLICY_PATH);
  const capture = new CaptureServer();
  const results: CaseResult[] = [];
  try {
    for (const vector of options.vectors) {
      const before = capture.arm(vector.response);
      const args = invocationArgs({
        adapter: options.adapter,
        policy,
        vector,
        manifest: options.manifest,
        host: capture.url,
      });
      const execution = await spawn(command, args, options.timeoutMs ?? 10_000);
      const failures: string[] = [];
      const captured = capture.requests.slice(before);
      const operation = options.manifest.operations.find(
        (candidate) => candidate.key === vector.operationKey,
      );
      if (!operation) {
        failures.push("manifest: operation not found");
      } else if (operation.deprecated) {
        if (execution.exitCode !== 2) {
          failures.push(
            `exit: expected deprecated-operation exit 2, got ${execution.exitCode}`,
          );
        }
        if (captured.length !== 0) {
          failures.push(
            `server: expected no request for deprecated operation, got ${captured.length}`,
          );
        }
        if (!execution.stderr.includes("Cannot call deprecated API operation")) {
          failures.push("stderr: expected a helpful deprecated-operation error");
        }
      } else {
        if (execution.exitCode !== 0) {
          failures.push(`exit: expected zero, got ${execution.exitCode}`);
        }
        if (captured.length !== 1) {
          failures.push(`server: expected one request, got ${captured.length}`);
        } else {
          failures.push(...requestDiff(vector.expectedRequest, captured[0]));
        }
      }
      if (!operation?.deprecated && execution.exitCode === 0) {
        const output = parseJson(execution.stdout);
        if (output?.status !== vector.response.status) {
          failures.push(
            `response: expected status ${vector.response.status}, got ${output?.status}`,
          );
        }
        const actualBody = output?.body ?? null;
        const bodyMatches = vector.response.sample === undefined
          ? actualBody === null || actualBody === ""
          : sameJson(actualBody, vector.response.sample);
        if (!bodyMatches) {
          failures.push(
            `response body: expected ${JSON.stringify(vector.response.sample ?? null)}, got ${JSON.stringify(output?.body ?? null)}`,
          );
        }
      }
      const result = {
        id: vector.id,
        passed: failures.length === 0,
        failures,
        process: execution,
      };
      results.push(result);
      if (!options.quiet) {
        process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${result.id}\n`);
      }
      if (!result.passed) {
        if (!options.quiet) {
          for (const failure of failures) process.stdout.write(`  ${failure}\n`);
        }
        if (options.failFast) break;
      }
    }
  } finally {
    capture.stop();
    await materialized?.cleanup();
  }
  return results;
}

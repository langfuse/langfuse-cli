import { invocationArgs } from "./invocation";
import { CaptureServer, requestDiff, sameJson } from "./capture";
import { REPOSITORY_ROOT } from "./catalog";
import type { ConformanceVector, Manifest } from "./types";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  manifest: Manifest;
  vectors: ConformanceVector[];
  command: string[];
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
    const child = Bun.spawn([...command, ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: undefined,
        LANGFUSE_SECRET_KEY: undefined,
        LANGFUSE_HOST: undefined,
        LANGFUSE_BASE_URL: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
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

function parseJson(stdout: string): any | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export async function runConformance(options: RunOptions): Promise<CaseResult[]> {
  if (options.command.length === 0) {
    throw new Error("Missing implementation command after --");
  }
  const capture = new CaptureServer();
  const results: CaseResult[] = [];
  try {
    for (const vector of options.vectors) {
      const before = capture.arm(vector.response);
      const args = invocationArgs({
        vector,
        manifest: options.manifest,
        host: capture.url,
      });
      const execution = await spawn(
        options.command,
        args,
        options.timeoutMs ?? 10_000,
      );
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
  }
  return results;
}

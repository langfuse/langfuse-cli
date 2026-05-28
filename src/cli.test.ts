import { describe, expect, test } from "bun:test";

import { run } from "./cli";

async function captureOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: any) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

describe("langfuse get-skill", () => {
  test("prints manual download instructions when github is blocked", async () => {
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;

    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("network blocked");
    }) as typeof fetch;

    process.exitCode = undefined;

    try {
      const output = await captureOutput(() =>
        run(["node", "langfuse", "get-skill"]),
      );

      expect(output.stdout).toBe("");
      expect(output.stderr).toContain(
        "Failed to fetch the latest Langfuse skill from GitHub.",
      );
      expect(output.stderr).toContain(
        "This environment may block direct GitHub access.",
      );
      expect(output.stderr).toContain(
        "https://raw.githubusercontent.com/langfuse/skills/main/skills/langfuse/SKILL.md",
      );
      expect(output.stderr).toContain("network blocked");
      expect(process.exitCode).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode ?? 0;
    }
  });
});

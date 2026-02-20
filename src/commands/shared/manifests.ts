import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, type JsonObject } from "./fs";

export interface TraceManifest {
  schema_version: number;
  langfuse: {
    trace_id: string;
    trace_url: string | null;
    session_id: string;
    host: string | null;
  };
  git: {
    commit_sha: string;
    commit_url: string | null;
    commit_message: string;
    branch: string;
    remote_url: string | null;
  };
  created_at: string;
}

export interface ManifestWithFile {
  filePath: string;
  mtimeMs: number;
  manifest: TraceManifest;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseManifest(obj: JsonObject): TraceManifest | null {
  const langfuseRaw = obj.langfuse;
  const gitRaw = obj.git;

  if (!langfuseRaw || typeof langfuseRaw !== "object" || Array.isArray(langfuseRaw)) {
    return null;
  }

  if (!gitRaw || typeof gitRaw !== "object" || Array.isArray(gitRaw)) {
    return null;
  }

  const langfuse = langfuseRaw as JsonObject;
  const git = gitRaw as JsonObject;

  const traceId = asString(langfuse.trace_id);
  const sessionId = asString(langfuse.session_id);
  const commitSha = asString(git.commit_sha);

  if (!traceId || !sessionId || !commitSha) {
    return null;
  }

  return {
    schema_version: typeof obj.schema_version === "number" ? obj.schema_version : 1,
    langfuse: {
      trace_id: traceId,
      trace_url: asNullableString(langfuse.trace_url),
      session_id: sessionId,
      host: asNullableString(langfuse.host),
    },
    git: {
      commit_sha: commitSha,
      commit_url: asNullableString(git.commit_url),
      commit_message: asString(git.commit_message),
      branch: asString(git.branch) || "unknown",
      remote_url: asNullableString(git.remote_url),
    },
    created_at: asString(obj.created_at),
  };
}

export async function readTraceManifests(traceDir: string): Promise<ManifestWithFile[]> {
  let entries: string[];
  try {
    entries = await readdir(traceDir);
  } catch {
    return [];
  }

  const manifests: ManifestWithFile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = join(traceDir, entry);
    const { data } = await readJsonFile(filePath);
    if (!data) {
      continue;
    }

    const manifest = parseManifest(data);
    if (!manifest) {
      continue;
    }

    let mtimeMs = 0;
    try {
      const stats = await stat(filePath);
      mtimeMs = stats.mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    manifests.push({ filePath, mtimeMs, manifest });
  }

  manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return manifests;
}

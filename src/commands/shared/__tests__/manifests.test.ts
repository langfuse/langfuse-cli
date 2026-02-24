import { describe, expect, it } from "bun:test";
import { parseManifest } from "../manifests";

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const obj = {
      schema_version: 1,
      langfuse: {
        trace_id: "abc123",
        trace_url: "https://cloud.langfuse.com/trace/abc123",
        session_id: "sess-1",
        host: "https://cloud.langfuse.com",
      },
      git: {
        commit_sha: "deadbeef",
        commit_url: "https://github.com/org/repo/commit/deadbeef",
        commit_message: "feat: add feature",
        branch: "main",
        remote_url: "https://github.com/org/repo.git",
      },
      created_at: "2024-01-01T00:00:00Z",
    };

    const result = parseManifest(obj);
    expect(result).not.toBeNull();
    expect(result!.langfuse.trace_id).toBe("abc123");
    expect(result!.langfuse.session_id).toBe("sess-1");
    expect(result!.git.commit_sha).toBe("deadbeef");
    expect(result!.git.branch).toBe("main");
    expect(result!.schema_version).toBe(1);
  });

  it("returns null when langfuse block is missing", () => {
    const obj = {
      git: { commit_sha: "abc" },
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(parseManifest(obj)).toBeNull();
  });

  it("returns null when git block is missing", () => {
    const obj = {
      langfuse: { trace_id: "abc", session_id: "sess" },
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(parseManifest(obj)).toBeNull();
  });

  it("returns null when trace_id is empty", () => {
    const obj = {
      langfuse: { trace_id: "", session_id: "sess" },
      git: { commit_sha: "abc" },
    };
    expect(parseManifest(obj)).toBeNull();
  });

  it("returns null when session_id is empty", () => {
    const obj = {
      langfuse: { trace_id: "abc", session_id: "" },
      git: { commit_sha: "abc" },
    };
    expect(parseManifest(obj)).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const obj = {
      langfuse: { trace_id: "abc", session_id: "sess" },
      git: {},
    };
    const result = parseManifest(obj);
    expect(result).not.toBeNull();
    expect(result!.git.commit_sha).toBe("");
    expect(result!.git.commit_url).toBeNull();
    expect(result!.git.branch).toBe("unknown");
    expect(result!.langfuse.trace_url).toBeNull();
  });

  it("defaults schema_version to 1 when missing", () => {
    const obj = {
      langfuse: { trace_id: "abc", session_id: "sess" },
      git: {},
    };
    const result = parseManifest(obj);
    expect(result!.schema_version).toBe(1);
  });

  it("rejects non-object langfuse", () => {
    expect(parseManifest({ langfuse: "string", git: {} })).toBeNull();
    expect(parseManifest({ langfuse: [1, 2], git: {} })).toBeNull();
  });

  it("rejects non-object git", () => {
    expect(parseManifest({ langfuse: { trace_id: "a", session_id: "b" }, git: "string" })).toBeNull();
  });
});

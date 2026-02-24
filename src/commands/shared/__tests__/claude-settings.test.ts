import { describe, expect, it } from "bun:test";
import {
  ensureHookCommand,
  hasHookCommand,
  removeHookCommand,
  removeHookCommandsByPattern,
} from "../claude-settings";
import type { JsonObject } from "../fs";

function makeSettings(hooks?: unknown): JsonObject {
  const settings: JsonObject = {};
  if (hooks !== undefined) {
    settings.hooks = hooks;
  }
  return settings;
}

describe("hasHookCommand", () => {
  it("returns false for empty settings", () => {
    expect(hasHookCommand({}, "Stop", "python3 hook.py")).toBe(false);
  });

  it("returns false when hooks is not an object", () => {
    expect(hasHookCommand({ hooks: "invalid" }, "Stop", "python3 hook.py")).toBe(false);
  });

  it("finds command in nested hooks array", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "python3 hook.py" }],
        },
      ],
    });
    expect(hasHookCommand(settings, "Stop", "python3 hook.py")).toBe(true);
  });

  it("returns false for non-matching command", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "python3 other.py" }],
        },
      ],
    });
    expect(hasHookCommand(settings, "Stop", "python3 hook.py")).toBe(false);
  });

  it("filters by matcher when provided", () => {
    const settings = makeSettings({
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "python3 hook.py" }],
        },
      ],
    });
    expect(hasHookCommand(settings, "PostToolUse", "python3 hook.py", "Bash")).toBe(true);
    expect(hasHookCommand(settings, "PostToolUse", "python3 hook.py", "Write")).toBe(false);
  });

  it("finds top-level command on group object", () => {
    const settings = makeSettings({
      Stop: [{ command: "python3 hook.py" }],
    });
    expect(hasHookCommand(settings, "Stop", "python3 hook.py")).toBe(true);
  });
});

describe("ensureHookCommand", () => {
  it("adds hook to empty settings", () => {
    const settings: JsonObject = {};
    const changed = ensureHookCommand(settings, {
      event: "Stop",
      matcher: "",
      command: "python3 hook.py",
    });
    expect(changed).toBe(true);
    expect(hasHookCommand(settings, "Stop", "python3 hook.py")).toBe(true);
  });

  it("is idempotent", () => {
    const settings: JsonObject = {};
    ensureHookCommand(settings, { event: "Stop", matcher: "", command: "python3 hook.py" });
    const changed = ensureHookCommand(settings, { event: "Stop", matcher: "", command: "python3 hook.py" });
    expect(changed).toBe(false);
  });

  it("appends to existing group with same matcher", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "existing.py" }],
        },
      ],
    });
    ensureHookCommand(settings, { event: "Stop", matcher: "", command: "python3 hook.py" });
    expect(hasHookCommand(settings, "Stop", "existing.py")).toBe(true);
    expect(hasHookCommand(settings, "Stop", "python3 hook.py")).toBe(true);
  });

  it("creates new group for different matcher", () => {
    const settings = makeSettings({
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "bash_hook.py" }],
        },
      ],
    });
    ensureHookCommand(settings, { event: "PostToolUse", matcher: "Write", command: "write_hook.py" });
    expect(hasHookCommand(settings, "PostToolUse", "bash_hook.py", "Bash")).toBe(true);
    expect(hasHookCommand(settings, "PostToolUse", "write_hook.py", "Write")).toBe(true);
  });
});

describe("removeHookCommand", () => {
  it("returns false for empty settings", () => {
    const settings: JsonObject = {};
    expect(removeHookCommand(settings, { event: "Stop", command: "hook.py" })).toBe(false);
  });

  it("removes nested hook command", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "keep.py" },
            { type: "command", command: "remove.py" },
          ],
        },
      ],
    });
    const changed = removeHookCommand(settings, { event: "Stop", command: "remove.py" });
    expect(changed).toBe(true);
    expect(hasHookCommand(settings, "Stop", "remove.py")).toBe(false);
    expect(hasHookCommand(settings, "Stop", "keep.py")).toBe(true);
  });

  it("removes entire group when last hook is removed", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "remove.py" }],
        },
      ],
    });
    removeHookCommand(settings, { event: "Stop", command: "remove.py" });
    expect(settings.hooks).toBeUndefined();
  });

  it("removes top-level command", () => {
    const settings = makeSettings({
      Stop: [{ command: "remove.py" }],
    });
    const changed = removeHookCommand(settings, { event: "Stop", command: "remove.py" });
    expect(changed).toBe(true);
    expect(settings.hooks).toBeUndefined();
  });
});

describe("removeHookCommandsByPattern", () => {
  it("removes commands matching pattern", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "python3 ~/.claude/hooks/langfuse_hook.py" },
            { type: "command", command: "other_hook.py" },
          ],
        },
      ],
    });
    const changed = removeHookCommandsByPattern(settings, {
      event: "Stop",
      pattern: "langfuse_hook.py",
    });
    expect(changed).toBe(true);
    expect(hasHookCommand(settings, "Stop", "python3 ~/.claude/hooks/langfuse_hook.py")).toBe(false);
    expect(hasHookCommand(settings, "Stop", "other_hook.py")).toBe(true);
  });

  it("removes variant paths (e.g. venv)", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "/usr/local/bin/python3 ~/.claude/hooks/langfuse_hook.py" },
          ],
        },
      ],
    });
    const changed = removeHookCommandsByPattern(settings, {
      event: "Stop",
      pattern: "langfuse_hook.py",
    });
    expect(changed).toBe(true);
    expect(settings.hooks).toBeUndefined();
  });

  it("returns false when no match", () => {
    const settings = makeSettings({
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "other.py" }],
        },
      ],
    });
    const changed = removeHookCommandsByPattern(settings, {
      event: "Stop",
      pattern: "langfuse_hook.py",
    });
    expect(changed).toBe(false);
  });
});

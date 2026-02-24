import { asObject, type JsonObject } from "./fs";

export type HookEvent = "Stop" | "PostToolUse" | "PreToolUse";

interface HookGroup {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

function ensureHooksContainer(settings: JsonObject): JsonObject {
  const hooks = asObject(settings.hooks);
  if (hooks) {
    return hooks;
  }

  const created: JsonObject = {};
  settings.hooks = created;
  return created;
}

function readGroups(hooks: JsonObject, event: HookEvent): unknown[] {
  const raw = hooks[event];
  if (Array.isArray(raw)) {
    return raw;
  }

  const empty: unknown[] = [];
  hooks[event] = empty;
  return empty;
}

function readGroupCommand(item: unknown): string | null {
  const obj = asObject(item);
  if (!obj) {
    return null;
  }

  const command = obj.command;
  if (typeof command === "string" && command.trim()) {
    return command;
  }

  return null;
}

function setGroups(
  settings: JsonObject,
  hooks: JsonObject,
  event: HookEvent,
  groups: unknown[],
): void {
  if (groups.length === 0) {
    delete hooks[event];
  } else {
    hooks[event] = groups;
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

export function hasHookCommand(
  settings: JsonObject,
  event: HookEvent,
  command: string,
  matcher?: string,
): boolean {
  const hooks = asObject(settings.hooks);
  if (!hooks) {
    return false;
  }

  const groups = hooks[event];
  if (!Array.isArray(groups)) {
    return false;
  }

  for (const item of groups) {
    const itemObj = asObject(item);
    const itemMatcher =
      itemObj && typeof itemObj.matcher === "string" ? itemObj.matcher : "";

    if (matcher !== undefined && itemMatcher !== matcher) {
      continue;
    }

    const topLevelCommand = readGroupCommand(item);
    if (topLevelCommand === command) {
      return true;
    }

    const obj = itemObj;
    if (!obj || !Array.isArray(obj.hooks)) {
      continue;
    }

    for (const hookItem of obj.hooks) {
      const hookObj = asObject(hookItem);
      if (!hookObj) {
        continue;
      }

      if (hookObj.command === command) {
        return true;
      }
    }
  }

  return false;
}

export function ensureHookCommand(
  settings: JsonObject,
  params: { event: HookEvent; matcher: string; command: string },
): boolean {
  const { event, matcher, command } = params;

  if (hasHookCommand(settings, event, command, matcher)) {
    return false;
  }

  const hooks = ensureHooksContainer(settings);
  const groups = readGroups(hooks, event);

  let targetGroup: JsonObject | null = null;
  for (const group of groups) {
    const groupObj = asObject(group);
    if (!groupObj) {
      continue;
    }

    const currentMatcher = typeof groupObj.matcher === "string" ? groupObj.matcher : "";
    if (currentMatcher === matcher && Array.isArray(groupObj.hooks)) {
      targetGroup = groupObj;
      break;
    }
  }

  if (!targetGroup) {
    const newGroup: HookGroup = {
      matcher,
      hooks: [],
    };
    groups.push(newGroup);
    targetGroup = newGroup as unknown as JsonObject;
  }

  if (!Array.isArray(targetGroup.hooks)) {
    targetGroup.hooks = [];
  }

  (targetGroup.hooks as unknown[]).push({
    type: "command",
    command,
  });

  hooks[event] = groups;
  return true;
}

export function removeHookCommand(
  settings: JsonObject,
  params: { event: HookEvent; command: string },
): boolean {
  const { event, command } = params;
  const hooks = asObject(settings.hooks);
  if (!hooks) {
    return false;
  }

  const groups = hooks[event];
  if (!Array.isArray(groups)) {
    return false;
  }

  let changed = false;
  const updatedGroups: unknown[] = [];

  for (const item of groups) {
    const obj = asObject(item);
    if (!obj) {
      updatedGroups.push(item);
      continue;
    }

    const topLevelCommand = readGroupCommand(obj);
    if (topLevelCommand === command) {
      changed = true;
      continue;
    }

    if (!Array.isArray(obj.hooks)) {
      updatedGroups.push(item);
      continue;
    }

    let removedFromGroup = false;
    const filteredHooks = (obj.hooks as unknown[]).filter((hook) => {
      const hookObj = asObject(hook);
      if (!hookObj) {
        return true;
      }

      if (hookObj.command === command) {
        changed = true;
        removedFromGroup = true;
        return false;
      }

      return true;
    });

    if (filteredHooks.length === 0) {
      if (removedFromGroup) {
        continue;
      }
      updatedGroups.push(obj);
      continue;
    }

    obj.hooks = filteredHooks;
    updatedGroups.push(obj);
  }

  if (!changed) {
    return false;
  }

  setGroups(settings, hooks, event, updatedGroups);
  return true;
}

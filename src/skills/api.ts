import { z } from "zod";

import { createApiClient } from "../client";
import type { ApiCallInput, ApiClientConfig, ApiContract, JsonValue } from "../contracts/types";
import { CliError, EXIT_HTTP, EXIT_LOCAL, EXIT_RESPONSE } from "../errors";

export interface SkillsConfig extends ApiClientConfig {
  contract: ApiContract;
  json: boolean;
}

export const skillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const skillSelectorSchema = z.union([
  z.strictObject({ label: z.string().min(1), version: z.never().optional() }),
  z.strictObject({ version: z.number().int().positive(), label: z.never().optional() }),
]);

const sha256Schema = z.string().refine((value) => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
});

const skillFileSchema = z.object({
  path: z.string(),
  sha256Hash: sha256Schema,
  contentLength: z.number().int().nonnegative(),
});

const skillVersionSchema = z.object({
  name: skillNameSchema,
  version: z.number().int().positive(),
  labels: z.array(z.string()),
  files: z.array(skillFileSchema).min(1),
});

const skillSummarySchema = z.object({
  name: skillNameSchema,
  productionVersion: z.number().int().positive().nullable(),
});

const skillListSchema = z.object({
  data: z.array(skillSummarySchema),
  meta: z.object({ hasNextPage: z.boolean() }),
});

const fileContentsSchema = z.object({
  data: z.array(z.object({ sha256Hash: sha256Schema, content: z.string() })),
});

export type SkillSelector = z.infer<typeof skillSelectorSchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const FILE_CONTENT_BATCH_SIZE = 50;
const MAX_SKILL_LIST_PAGES = 100;

export async function fetchSkills(
  config: SkillsConfig,
  tag?: string,
): Promise<z.infer<typeof skillSummarySchema>[]> {
  const skills = new Map<string, z.infer<typeof skillSummarySchema>>();
  for (let page = 1; page <= MAX_SKILL_LIST_PAGES; page++) {
    const query: Record<string, string> = { page: String(page), limit: "100" };
    if (tag !== undefined) query.tag = tag;
    const value = await requestJson(config, "skills_list", { query });
    const result = skillListSchema.safeParse(value);
    if (!result.success) {
      throw new CliError("Langfuse returned an invalid skill list", EXIT_RESPONSE);
    }
    for (const skill of result.data.data) skills.set(skill.name, skill);
    if (!result.data.meta.hasNextPage) return [...skills.values()];
  }
  throw new CliError(`Langfuse skill listing exceeded ${MAX_SKILL_LIST_PAGES} pages; no skills were installed`, EXIT_RESPONSE);
}

export async function fetchSkill(
  config: SkillsConfig,
  name: string,
  selector: SkillSelector,
): Promise<SkillVersion> {
  const query: Record<string, string> = {};
  if (selector.version !== undefined) {
    query.version = String(selector.version);
  } else {
    query.label = selector.label;
  }
  const value = await requestJson(config, "skills_get", { path: { skillName: name }, query });
  const result = skillVersionSchema.safeParse(value);
  if (!result.success || result.data.name !== name) {
    throw new CliError("Langfuse returned an invalid skill manifest", EXIT_RESPONSE);
  }
  return result.data;
}

export async function fetchLatestSkill(config: SkillsConfig, name: string): Promise<SkillVersion | undefined> {
  const value = await requestJson(config, "skills_get", {
    path: { skillName: name }, query: { label: "latest" },
  }, { allowNotFound: true });
  return value === undefined ? undefined : parseSkillVersion(value, name);
}

export async function createSkillVersion(
  config: SkillsConfig,
  name: string,
  files: Array<{ path: string; content: string }>,
  commitMessage?: string,
): Promise<SkillVersion> {
  const value = await requestJson(config, "skills_createVersion", {
    body: { files, ...(commitMessage === undefined ? {} : { commitMessage }) },
  });
  return parseSkillVersion(value, name);
}

export async function setSkillLabels(
  config: SkillsConfig,
  name: string,
  version: number,
  labels: string[],
): Promise<SkillVersion> {
  const value = await requestJson(config, "skills_setLabels", {
    path: { skillName: name, skillVersion: version }, body: { labels },
  });
  const skill = parseSkillVersion(value, name);
  if (skill.version !== version || labels.some((label) => !skill.labels.includes(label))) {
    throw new CliError("Langfuse returned a skill version that does not match the requested labels", EXIT_RESPONSE);
  }
  return skill;
}

function parseSkillVersion(value: unknown, name: string): SkillVersion {
  const result = skillVersionSchema.safeParse(value);
  if (!result.success || result.data.name !== name || new Set(result.data.files.map((file) => file.path)).size !== result.data.files.length) {
    throw new CliError("Langfuse returned an invalid skill manifest", EXIT_RESPONSE);
  }
  return result.data;
}

export async function fetchFileContents(
  config: SkillsConfig,
  hashes: string[],
): Promise<Map<string, string>> {
  const value = await requestJson(config, "skills_getFileContents", {
    query: { sha256Hashes: hashes.join(",") },
  });
  const result = fileContentsSchema.safeParse(value);
  if (!result.success) {
    throw new CliError("Langfuse returned invalid skill file contents", EXIT_RESPONSE);
  }
  const requested = new Set(hashes);
  const contents = new Map<string, string>();
  for (const entry of result.data.data) {
    if (!requested.has(entry.sha256Hash) || contents.has(entry.sha256Hash)) {
      throw new CliError("Langfuse returned invalid skill file contents", EXIT_RESPONSE);
    }
    contents.set(entry.sha256Hash, entry.content);
  }
  if (contents.size !== hashes.length) {
    throw new CliError("Langfuse returned incomplete skill file contents", EXIT_RESPONSE);
  }
  return contents;
}

async function requestJson(
  config: SkillsConfig,
  operationId: string,
  input: Partial<ApiCallInput>,
  options: { allowNotFound?: boolean } = {},
): Promise<unknown> {
  const operation = config.contract.operations.find((candidate) => candidate.operationId === operationId);
  if (!operation) {
    throw new CliError(`Bundled API contract ${config.contract.apiVersion} has no ${operationId} operation`, EXIT_LOCAL);
  }
  const client = createApiClient(config);
  const request: ApiCallInput = { path: {}, query: {}, headers: {}, cookies: {}, ...input };
  const response = await client.call(operation, request);
  if (response.status === 404 && options.allowNotFound && isResourceNotFound(response.body)) return undefined;
  if (!response.ok) {
    const { url, method } = client.prepare(operation, request);
    throw new CliError(`${method} ${url.href} returned HTTP ${response.status}${responseError(response.body)}`, EXIT_HTTP);
  }
  return response.body;
}

function isResourceNotFound(body: JsonValue): boolean {
  return body !== null && typeof body === "object" && !Array.isArray(body) &&
    typeof body.message === "string" &&
    (body.code === "resource_not_found" || body.error === "LangfuseNotFoundError");
}

function responseError(body: JsonValue): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const message = body.message ?? body.error;
    if (typeof message === "string") return `: ${message}`;
  }
  const text = typeof body === "string" ? body.trim() : body === null ? "" : JSON.stringify(body);
  return text ? `: ${text.slice(0, 300)}` : "";
}

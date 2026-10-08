import { z } from "zod";

import packageJson from "../../package.json";
import { CliError, EXIT_CONFIG, EXIT_HTTP, EXIT_NETWORK } from "../errors";

export interface SkillsConfig {
  publicKey?: string;
  secretKey?: string;
  host: string;
  timeoutMs: number;
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

const skillListSchema = z.object({
  data: z.array(z.object({ name: skillNameSchema })),
  meta: z.object({ hasNextPage: z.boolean() }),
});

const fileContentsSchema = z.object({
  data: z.array(z.object({ sha256Hash: sha256Schema, content: z.string() })),
});

export type SkillSelector = z.infer<typeof skillSelectorSchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
type SkillVersion = z.infer<typeof skillVersionSchema>;

export const FILE_CONTENT_BATCH_SIZE = 50;

export async function fetchSkillNamesByTag(
  config: SkillsConfig,
  tag: string,
): Promise<string[]> {
  const names = new Set<string>();
  for (let page = 1; ; page++) {
    const value = await getJson(config, "", { tag, page: String(page), limit: "100" });
    const result = skillListSchema.safeParse(value);
    if (!result.success) {
      throw new CliError("Langfuse returned an invalid skill list", EXIT_HTTP);
    }
    for (const skill of result.data.data) names.add(skill.name);
    if (!result.data.meta.hasNextPage) return [...names];
  }
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
  const value = await getJson(config, encodeURIComponent(name), query);
  const result = skillVersionSchema.safeParse(value);
  if (!result.success || result.data.name !== name) {
    throw new CliError("Langfuse returned an invalid skill manifest", EXIT_HTTP);
  }
  return result.data;
}

export async function fetchFileContents(
  config: SkillsConfig,
  hashes: string[],
): Promise<Map<string, string>> {
  const value = await getJson(config, "files/content", {
    sha256Hashes: hashes.join(","),
  });
  const result = fileContentsSchema.safeParse(value);
  if (!result.success) {
    throw new CliError("Langfuse returned invalid skill file contents", EXIT_HTTP);
  }
  const requested = new Set(hashes);
  const contents = new Map<string, string>();
  for (const entry of result.data.data) {
    if (!requested.has(entry.sha256Hash) || contents.has(entry.sha256Hash)) {
      throw new CliError("Langfuse returned invalid skill file contents", EXIT_HTTP);
    }
    contents.set(entry.sha256Hash, entry.content);
  }
  if (contents.size !== hashes.length) {
    throw new CliError("Langfuse returned incomplete skill file contents", EXIT_HTTP);
  }
  return contents;
}

async function getJson(
  config: SkillsConfig,
  route: string,
  query: Record<string, string>,
): Promise<unknown> {
  if (!config.publicKey || !config.secretKey) {
    throw new CliError("This command requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY", EXIT_CONFIG);
  }
  const host = config.host.endsWith("/") ? config.host : `${config.host}/`;
  const url = new URL(`api/public/unstable/skills${route ? `/${route}` : ""}`, host);
  url.search = new URLSearchParams(query).toString();
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization,
        "user-agent": `langfuse-cli/${packageJson.version}`,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new CliError(`GET ${url.href} failed: ${error instanceof Error ? error.message : String(error)}`, EXIT_NETWORK);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`GET ${url.href} returned HTTP ${response.status}${responseError(text)}`, EXIT_HTTP);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError("Langfuse returned invalid JSON for the skill", EXIT_HTTP);
  }
}

function responseError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.message ?? parsed?.error;
    if (typeof message === "string") return `: ${message}`;
  } catch {}
  return body.trim() ? `: ${body.trim().slice(0, 300)}` : "";
}

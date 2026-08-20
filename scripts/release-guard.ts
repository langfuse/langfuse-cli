// Publish-time guard for .github/workflows/release.yml. Reads the release
// context from the environment, validates it against the shared policy in
// release-config.ts, and prints the npm dist-tag as its only stdout line.
import { releaseGuard } from "./release-config";

const REGISTRY_URL = "https://registry.npmjs.org/langfuse-cli";

async function currentLatest(): Promise<string | null> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  // 404 means the package has never been published (first release).
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${REGISTRY_URL}`);
  }
  const body = (await response.json()) as { "dist-tags"?: Record<string, string> };
  return body["dist-tags"]?.latest ?? null;
}

const tagName = process.env.TAG_NAME;
const isPrerelease = process.env.IS_PRERELEASE;
if (!tagName || (isPrerelease !== "true" && isPrerelease !== "false")) {
  throw new Error("release-guard requires TAG_NAME and IS_PRERELEASE (true|false) in the environment");
}
const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
  version: string;
};

const distTag = releaseGuard({
  version: pkg.version,
  tagName,
  isPrerelease: isPrerelease === "true",
  currentLatest: await currentLatest(),
});
console.log(distTag);

// Publish-time guard for .github/workflows/release.yml. Reads the release
// context from the environment, validates it against the shared policy in
// release-config.ts, and prints the npm dist-tag as its only stdout line.
// The workflow runs it twice: once early to fail fast, and once immediately
// before `npm publish` so the monotonicity check reflects the registry state
// at publish time.
import { releaseGuard } from "./release-config";

const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
  name: string;
  version: string;
};

async function currentDistTags(): Promise<Record<string, string> | null> {
  const url = `https://registry.npmjs.org/${pkg.name}`;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  // 404 means the package has never been published (first release).
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${url}`);
  }
  const body = (await response.json()) as { "dist-tags"?: Record<string, string> };
  return body["dist-tags"] ?? null;
}

const tagName = process.env.TAG_NAME;
const isPrerelease = process.env.IS_PRERELEASE;
if (!tagName || (isPrerelease !== "true" && isPrerelease !== "false")) {
  throw new Error("release-guard requires TAG_NAME and IS_PRERELEASE (true|false) in the environment");
}

const distTag = releaseGuard({
  version: pkg.version,
  tagName,
  isPrerelease: isPrerelease === "true",
  currentDistTags: await currentDistTags(),
});
console.log(distTag);

// Publish-time guard for .github/workflows/release.yml. It validates both npm
// package identities, refuses divergent channels, and permits recovery only
// when an existing package version came from this exact release commit.
import {
  CANONICAL_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
} from "./npm-packages";
import {
  npmReleasePlan,
  type NpmRegistryPackageState,
} from "./npm-release-plan";

const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
  name: string;
  version: string;
};

async function registryPackageState(
  packageName: string,
  version: string,
): Promise<NpmRegistryPackageState> {
  const encodedName = encodeURIComponent(packageName);
  const packageUrl = `https://registry.npmjs.org/${encodedName}`;
  const packageResponse = await fetch(packageUrl, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (packageResponse.status === 404) {
    return { name: packageName, currentDistTags: null, publishedGitHead: null };
  }
  if (!packageResponse.ok) {
    throw new Error(
      `npm registry returned HTTP ${packageResponse.status} for ${packageUrl}`,
    );
  }
  const packageBody = (await packageResponse.json()) as {
    "dist-tags"?: Record<string, string>;
  };

  const versionUrl = `${packageUrl}/${encodeURIComponent(version)}`;
  const versionResponse = await fetch(versionUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (versionResponse.status === 404) {
    return {
      name: packageName,
      currentDistTags: packageBody["dist-tags"] ?? null,
      publishedGitHead: null,
    };
  }
  if (!versionResponse.ok) {
    throw new Error(
      `npm registry returned HTTP ${versionResponse.status} for ${versionUrl}`,
    );
  }
  const versionBody = (await versionResponse.json()) as { gitHead?: unknown };
  if (typeof versionBody.gitHead !== "string") {
    throw new Error(
      `${packageName}@${version} exists without gitHead metadata; refusing to guess whether this release published it`,
    );
  }
  return {
    name: packageName,
    currentDistTags: packageBody["dist-tags"] ?? null,
    publishedGitHead: versionBody.gitHead,
  };
}

const tagName = process.env.TAG_NAME;
const isPrerelease = process.env.IS_PRERELEASE;
const releaseSha = process.env.RELEASE_SHA;
if (
  !tagName ||
  (isPrerelease !== "true" && isPrerelease !== "false") ||
  !releaseSha
) {
  throw new Error(
    "release-guard requires TAG_NAME, IS_PRERELEASE (true|false), and RELEASE_SHA in the environment",
  );
}
if (pkg.name !== CANONICAL_PACKAGE_NAME) {
  throw new Error(
    `package.json must use canonical name ${CANONICAL_PACKAGE_NAME}; found ${pkg.name}`,
  );
}

const [canonical, legacy] = await Promise.all([
  registryPackageState(CANONICAL_PACKAGE_NAME, pkg.version),
  registryPackageState(LEGACY_PACKAGE_NAME, pkg.version),
]);
const plan = npmReleasePlan({
  version: pkg.version,
  tagName,
  isPrerelease: isPrerelease === "true",
  releaseSha,
  packages: { canonical, legacy },
});

if (process.argv.includes("--json")) console.log(JSON.stringify(plan));
else console.log(plan.distTag);

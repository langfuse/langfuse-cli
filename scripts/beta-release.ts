import { gt, inc, prerelease, rcompare, valid } from "semver";
import { assertReleasableVersion, releaseGuard } from "./release-config";
import type { NpmReleasePlan } from "./npm-release-plan";
import { CANONICAL_PACKAGE_NAME } from "./npm-packages";

export interface BetaRegistryPackage {
  distTags: Record<string, string>;
  versions: Record<string, { gitHead?: string }>;
}

function isBeta(version: string): boolean {
  return valid(version) !== null && prerelease(version)?.[0] === "beta";
}

type BetaReleasePlan = Omit<NpmReleasePlan, "packages"> & {
  packages: Pick<NpmReleasePlan["packages"], "canonical">;
};

export function betaPublishPlan(input: {
  version: string;
  releaseSha: string;
  registry: BetaRegistryPackage;
  tagName?: string;
}): BetaReleasePlan {
  if (!isBeta(input.version)) throw new Error("Beta publishing requires a beta version");
  const published = input.registry.versions[input.version];
  const distTag = releaseGuard({
    version: input.version,
    tagName: input.tagName ?? `v${input.version}`,
    isPrerelease: true,
    currentDistTags: published ? null : input.registry.distTags,
  });
  if (published && published.gitHead !== input.releaseSha) {
    throw new Error(`${CANONICAL_PACKAGE_NAME}@${input.version} already exists from a different or missing gitHead`);
  }
  return {
    version: input.version,
    distTag,
    packages: {
      canonical: { name: CANONICAL_PACKAGE_NAME, status: published ? "already-published" : "publish" },
    },
  };
}

export function betaReleasePlan(input: {
  version: string;
  releaseSha: string;
  registry: BetaRegistryPackage;
}): BetaReleasePlan {
  const current = assertReleasableVersion(input.version);
  if (prerelease(current) && !isBeta(current)) {
    throw new Error("Beta releases require a stable or beta package.json version");
  }
  let next = isBeta(current) ? current : inc(current, "preminor", "beta")!;
  const registry = input.registry;
  const betaVersions = Object.keys(registry.versions).filter(isBeta).sort(rcompare);
  const retries = betaVersions.filter((version) =>
    registry.versions[version]?.gitHead === input.releaseSha,
  );
  if (retries.length > 1) {
    throw new Error("Multiple beta versions exist for this commit; inspect npm before retrying");
  }
  const stable = registry.distTags.latest;
  if (stable !== undefined) {
    assertReleasableVersion(stable);
    if (prerelease(stable)) throw new Error("npm latest must be a stable version");
    const seed = inc(stable, "preminor", "beta")!;
    if (gt(seed, next)) next = seed;
  }
  const highest = betaVersions[0];
  if (highest && !gt(next, highest)) next = inc(highest, "prerelease", "beta")!;
  const version = retries[0] ?? next;

  const beta = registry.distTags.beta;
  if (beta !== undefined) {
    if (!isBeta(beta)) throw new Error("npm beta must point to a beta version");
    const gitHead = registry.versions[beta]?.gitHead;
    if (!gitHead || !/^[0-9a-f]{40}$/.test(gitHead)) {
      throw new Error(`Published beta ${beta} is missing valid gitHead metadata`);
    }
  }

  return betaPublishPlan({ ...input, version });
}

async function registryPackage(packageName: string): Promise<BetaRegistryPackage> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { distTags: {}, versions: {} };
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`);
  }
  const body = await response.json() as {
    "dist-tags"?: Record<string, string>;
    versions?: BetaRegistryPackage["versions"];
  };
  return { distTags: body["dist-tags"] ?? {}, versions: body.versions ?? {} };
}

if (import.meta.main) {
  const path = `${import.meta.dir}/../package.json`;
  const pkg = await Bun.file(path).json();
  if (pkg.name !== CANONICAL_PACKAGE_NAME) throw new Error("Unexpected npm package identity");

  if (process.argv.includes("--apply")) {
    const version = assertReleasableVersion(process.env.BETA_VERSION ?? "");
    if (!isBeta(version)) throw new Error("Beta publishing requires a beta version");
    await Bun.write(path, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  } else {
    const releaseSha = process.env.GITHUB_SHA ?? "";
    const registry = await registryPackage(CANONICAL_PACKAGE_NAME);
    if (process.argv.includes("--plan")) {
      if (!process.env.TAG_NAME || process.env.IS_PRERELEASE !== "true") {
        throw new Error("Beta publish checks require TAG_NAME and IS_PRERELEASE=true");
      }
      console.log(JSON.stringify(betaPublishPlan({
        version: pkg.version, releaseSha, registry, tagName: process.env.TAG_NAME,
      })));
    } else {
      const plan = betaReleasePlan({ version: pkg.version, releaseSha, registry });
      const skip = plan.packages.canonical.status === "already-published";
      console.log(`version=${plan.version}`);
      console.log(`skip=${skip}`);
    }
  }
}

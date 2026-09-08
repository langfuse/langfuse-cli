import { releaseGuard } from "./release-config";

export type NpmPackageId = "canonical" | "legacy";
export type NpmPackageStatus = "publish" | "already-published";

export interface NpmRegistryPackageState {
  name: string;
  currentDistTags: Record<string, string> | null;
  publishedGitHead: string | null;
}

export interface NpmReleasePlan {
  version: string;
  distTag: string;
  packages: Record<
    NpmPackageId,
    { name: string; status: NpmPackageStatus }
  >;
}

export function npmReleasePlan(input: {
  version: string;
  tagName: string;
  isPrerelease: boolean;
  releaseSha: string;
  packages: Record<NpmPackageId, NpmRegistryPackageState>;
}): NpmReleasePlan {
  if (!/^[0-9a-f]{40}$/.test(input.releaseSha)) {
    throw new Error("release SHA must be a full lowercase commit SHA");
  }

  const distTag = releaseGuard({
    version: input.version,
    tagName: input.tagName,
    isPrerelease: input.isPrerelease,
    currentDistTags: null,
  });
  const entries = Object.entries(input.packages) as [
    NpmPackageId,
    NpmRegistryPackageState,
  ][];
  const publishedEntries = entries.filter(
    ([, state]) => state.publishedGitHead !== null,
  );

  for (const [, state] of publishedEntries) {
    if (state.publishedGitHead !== input.releaseSha) {
      throw new Error(
        `${state.name}@${input.version} already exists from git head ${state.publishedGitHead}; expected ${input.releaseSha}`,
      );
    }
  }

  if (publishedEntries.length === 0) {
    const currentVersions = entries
      .map(([, state]) => state.currentDistTags?.[distTag])
      .filter((version): version is string => version !== undefined);
    if (new Set(currentVersions).size > 1) {
      throw new Error(
        `npm dist-tag "${distTag}" differs between package names (${currentVersions.join(
          " vs ",
        )}); recover the previous dual publish before releasing ${input.version}`,
      );
    }
  }

  const packages = Object.fromEntries(
    entries.map(([id, state]) => {
      if (state.publishedGitHead !== null) {
        return [id, { name: state.name, status: "already-published" as const }];
      }
      releaseGuard({
        version: input.version,
        tagName: input.tagName,
        isPrerelease: input.isPrerelease,
        currentDistTags: state.currentDistTags,
      });
      return [id, { name: state.name, status: "publish" as const }];
    }),
  ) as NpmReleasePlan["packages"];

  return { version: input.version, distTag, packages };
}

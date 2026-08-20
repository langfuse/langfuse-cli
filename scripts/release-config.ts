import { gt, inc, prerelease, valid, validRange } from "semver";

export interface ReleaseOptions {
  dryRun: boolean;
  allowDirty: boolean;
  publishLocal: boolean;
  showHelp: boolean;
  version?: string;
  tag?: string;
}

export function parseReleaseArgs(args: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    dryRun: false,
    allowDirty: false,
    publishLocal: false,
    showHelp: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--publish-local") options.publishLocal = true;
    else if (argument === "--help" || argument === "-h") options.showHelp = true;
    else if (argument === "--version" || argument === "--tag") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--version") options.version = value;
      else options.tag = value;
    } else {
      throw new Error(`Unknown release option: ${argument}`);
    }
  }
  if (options.tag && !options.publishLocal) {
    throw new Error(
      "--tag only applies to --publish-local; the CI publish derives the dist-tag from the version",
    );
  }
  return options;
}

export const PRERELEASE_IDENTIFIERS = ["alpha", "beta", "rc"] as const;
export type PrereleaseIdentifier = (typeof PRERELEASE_IDENTIFIERS)[number];

export interface VersionOption {
  label: string;
  version?: string;
  // pre* options need a second prompt for the identifier
  preLevel?: "prepatch" | "preminor" | "premajor" | "prerelease";
}

// Menu entries offered for the current version. Stable versions offer the
// three direct bumps plus pre* entry points; prerelease versions lead with
// continuing the line, graduating to stable, or switching identifier.
export function versionMenu(current: string): VersionOption[] {
  if (!valid(current)) throw new Error(`Invalid semver: ${current}`);
  const currentPrerelease = prerelease(current);
  if (currentPrerelease) {
    const identifier = String(currentPrerelease[0]);
    const options: VersionOption[] = [
      { label: `prerelease  ${inc(current, "prerelease")}`, version: inc(current, "prerelease")! },
      { label: `graduate    ${inc(current, "patch")}`, version: inc(current, "patch")! },
    ];
    for (const candidate of PRERELEASE_IDENTIFIERS) {
      if (candidate === identifier) continue;
      const switched = inc(current, "prerelease", candidate);
      if (switched) {
        options.push({ label: `${identifier} -> ${candidate}  ${switched}`, version: switched });
      }
    }
    return options;
  }
  return [
    { label: `patch     ${inc(current, "patch")}`, version: inc(current, "patch")! },
    { label: `minor     ${inc(current, "minor")}`, version: inc(current, "minor")! },
    { label: `major     ${inc(current, "major")}`, version: inc(current, "major")! },
    { label: "prepatch  (alpha/beta/rc)", preLevel: "prepatch" },
    { label: "preminor  (alpha/beta/rc)", preLevel: "preminor" },
    { label: "premajor  (alpha/beta/rc)", preLevel: "premajor" },
  ];
}

export function prereleaseVersion(
  current: string,
  level: "prepatch" | "preminor" | "premajor" | "prerelease",
  identifier: PrereleaseIdentifier,
): string {
  const next = inc(current, level, identifier);
  if (!next) throw new Error(`Cannot compute ${level} ${identifier} from ${current}`);
  return next;
}

// The single releasable-version policy shared by the cut script and the
// publish workflow (via scripts/release-guard.ts): normalized semver, no
// build metadata, prerelease identifiers restricted to the exact-case set
// the dist-tag derivation understands. Returns the normalized version.
export function assertReleasableVersion(raw: string): string {
  if (raw.includes("+")) {
    throw new Error(
      `Build metadata is not releasable: ${raw} (the dist-tag and tag guards cannot classify it)`,
    );
  }
  const normalized = valid(raw);
  if (!normalized) throw new Error(`Invalid semver: ${raw}`);
  const prereleaseParts = prerelease(normalized);
  if (prereleaseParts) {
    const identifier = String(prereleaseParts[0]);
    if (!(PRERELEASE_IDENTIFIERS as readonly string[]).includes(identifier)) {
      throw new Error(
        `Prerelease identifier "${identifier}" is not releasable; use one of: ${PRERELEASE_IDENTIFIERS.join(", ")} (exact case)`,
      );
    }
  }
  return normalized;
}

// Publish-time guard used by the GitHub Actions workflow. Validates the
// version policy, the tag <-> version binding, GitHub pre-release flag
// consistency, and dist-tag monotonicity on the derived channel; returns
// the npm dist-tag.
export function releaseGuard(input: {
  version: string;
  tagName: string;
  isPrerelease: boolean;
  // npm's current dist-tags map, or null when the package has never been
  // published (first release)
  currentDistTags: Record<string, string> | null;
}): string {
  const version = assertReleasableVersion(input.version);
  if (version !== input.version) {
    throw new Error(
      `package.json version ${input.version} is not in normalized form (${version})`,
    );
  }
  if (input.tagName !== `v${version}`) {
    throw new Error(
      `Release tag ${input.tagName} does not match package.json version ${version}`,
    );
  }
  const isPrereleaseVersion = prerelease(version) !== null;
  if (isPrereleaseVersion && !input.isPrerelease) {
    throw new Error(
      `Prerelease version ${version} must be published as a GitHub pre-release`,
    );
  }
  if (!isPrereleaseVersion && input.isPrerelease) {
    throw new Error(
      `Stable version ${version} must not be marked as a GitHub pre-release`,
    );
  }
  const distTag = publishTagForVersion(version);
  // Monotonicity on the channel being published: latest never moves to an
  // older stable, and a stale alpha/beta/rc draft never regresses its own
  // channel either. A channel with no current value (first publish on it)
  // passes.
  const currentOnChannel = input.currentDistTags?.[distTag];
  if (currentOnChannel !== undefined && !gt(version, currentOnChannel)) {
    throw new Error(
      `Refusing to move npm dist-tag "${distTag}" backwards: ${version} is not greater than the current ${distTag} ${currentOnChannel}`,
    );
  }
  return distTag;
}

export function publishTagForVersion(
  version: string,
  explicitTag?: string,
): string {
  if (!valid(version)) throw new Error(`Invalid semver: ${version}`);
  const prereleaseParts = prerelease(version);
  const prereleaseTag = prereleaseParts?.[0]?.toString().toLowerCase();
  if (
    explicitTag === undefined &&
    prereleaseTag &&
    !/^[A-Za-z]/.test(prereleaseTag)
  ) {
    throw new Error(
      `Cannot infer an npm dist-tag from ${version}; pass --tag explicitly.`,
    );
  }
  const tag = explicitTag ?? prereleaseTag ?? "latest";
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`Invalid npm dist-tag: ${tag}`);
  }
  if (validRange(tag) !== null) {
    throw new Error(`npm dist-tag must not be a valid SemVer range: ${tag}`);
  }
  if (prereleaseParts && tag === "latest") {
    throw new Error(`Prerelease ${version} cannot be published with the latest tag`);
  }
  return tag;
}

export function npmEnvironment(
  source: NodeJS.ProcessEnv,
  cache: string,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...source,
    npm_config_cache: cache,
  };
  delete environment.npm_config_tag;
  delete environment.NPM_CONFIG_TAG;
  return environment;
}

import { prerelease, valid, validRange } from "semver";

export interface ReleaseOptions {
  dryRun: boolean;
  allowDirty: boolean;
  showHelp: boolean;
  version?: string;
  tag?: string;
}

export function parseReleaseArgs(args: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    dryRun: false,
    allowDirty: false,
    showHelp: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
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
  return options;
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

// Single source of truth for option names the CLI claims before operation
// parsing. The contract compiler validates override flag aliases against
// these, so an alias can never be shadowed at runtime.
export const GLOBAL_VALUE_FLAG_NAMES = [
  "public-key",
  "secret-key",
  "host",
  "env",
  "api-version",
  "timeout",
  "output",
] as const;

export const GLOBAL_BOOLEAN_FLAG_NAMES = ["json", "curl", "show-secrets"] as const;

export const BODY_CHANNEL_FLAG_NAMES = ["body-json", "body-file"] as const;

export const PAGINATION_FLAG_NAMES = ["all", "max-items"] as const;

export const RESERVED_OPTION_NAMES: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_VALUE_FLAG_NAMES,
  ...GLOBAL_BOOLEAN_FLAG_NAMES,
  ...BODY_CHANNEL_FLAG_NAMES,
  ...PAGINATION_FLAG_NAMES,
]);

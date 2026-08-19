# Maintenance

## OpenAPI contracts

Builds compile committed OpenAPI snapshots into compact versioned contracts
under ignored `dist/contracts/`. Catalog entries record the exact committed
hash; snapshots with explicit local annotations also record the upstream hash
and modification name. Generated contracts are packaged on npm but are not
committed.

```sh
# Build the Bun CLI and all versioned contracts
bun run build

# Add or refresh an immutable upstream snapshot
bun run conformance:sync -- --version <version>

# Add a stable release snapshot, update metadata, and verify it
bun run conformance:add-version -- v4.11.0
```

## Testing

The version-pinned black-box suite lives in [`conformance/`](conformance/README.md).
It invokes every operation through the real CLI across historical Langfuse
specs. Active operations make one minimally valid mocked API call; operations
marked `deprecated: true` must fail before any network request.

```sh
bun test
bun run conformance:all
```

`bun test` verifies the generator, schemas, serialization, capture oracle,
deprecation policy, and legacy CLI compatibility. `bun run conformance:all`
builds the package and checks every operation through the native CLI using its
lossless JSON input path. CI runs both.

## Command goldens and overrides

The user-facing command surface (resource, action, aliases, deprecation) of
every snapshot is pinned in reviewed goldens under `conformance/goldens/`.
Tests and the build fail when compiled names differ from the goldens, so a
change to the naming heuristics cannot silently rename commands. After an
intentional naming change, regenerate and review the diff:

```sh
bun run goldens:update
```

All option flags are derived mechanically: query/header parameters and
request-body fields kebab-case their wire names (`objectId` -> `--object-id`),
so new spec versions get flags without per-parameter maintenance. The
compiler validates each operation's full flag namespace (parameters, aliases,
body fields, reserved and global flags) and fails the build when a new
snapshot introduces a collision, instead of silently shipping a dead or
hijacked flag.

Hand-written naming exceptions live in `src/contracts/overrides.json` and are
applied by the contract compiler, never hardcoded in the runtime: extra
parameter flag spellings (`parameterFlagAliases`, e.g. `--prompt-version`),
body-field flag renames for collisions (`bodyFieldFlags`, e.g.
`llmConnections_upsert.secretKey` -> `--provider-secret-key` because
`--secret-key` is the global auth flag), and per-version command overrides.
A snapshot that lacks the referenced parameter or field skips the entry, but
an entry applied in no snapshot at all fails the build, tests, and
`goldens:update`, so stale overrides cannot rot silently.

## Releases

Push to `main` freely; nothing publishes on push. Releases are a three-step
flow with a human gate in the middle:

```sh
bun run release
```

1. **Cut** (local, interactive): verifies you are on `main`, in sync with
   origin, with green CI and a clean tree; asks for the next version
   (patch/minor/major, or alpha/beta/rc prereleases); verifies the version is
   not on npm and the tag is free; runs typecheck, both test suites, and the
   full conformance build; then pushes a `chore(release): vX.Y.Z` commit plus
   the `vX.Y.Z` tag and opens a **draft GitHub release** with generated notes.
2. **Publish the GitHub release**: edit the notes on GitHub and click
   Publish. This is the release decision — nothing reaches npm before it.
3. **npm publish** (automatic): publishing the release triggers
   [`release.yml`](.github/workflows/release.yml), which re-verifies the tag
   (tag == package.json version, commit on main, prerelease consistency),
   re-runs all gates, and publishes via **npm trusted publishing (OIDC)** with
   provenance attestations. No npm token exists anywhere.

npm dist-tags derive from the version: stable → `latest`, `-alpha.N` →
`alpha`, `-beta.N` → `beta`, `-rc.N` → `rc`. Prerelease versions must be
marked "pre-release" on the GitHub release (the draft is created that way);
the workflow fails closed on any mismatch. Graduating `1.1.0-rc.1` → `1.1.0`
is just another `bun run release` run choosing "graduate".

To test the cut flow without pushing anything:

```sh
bun run release -- --dry-run
```

If testing local changes to the release script itself, add `--allow-dirty`.
Never use `--allow-dirty` for a real release.

### Escape hatch: publishing without GitHub Actions

Only when Actions is unavailable, publish directly from a machine:

```sh
bun run release -- --publish-local
```

This runs the same gates plus `npm pack --dry-run` and an explicit publish
confirmation, and requires interactive npm authentication (with OTP if the
package disallows tokens). It does not commit or tag; do that manually after.

### One-time npm configuration

On npmjs.com → `langfuse-cli` → Settings:

1. **Trusted Publisher** → GitHub: owner `langfuse`, repository `langfuse-cli`,
   workflow filename `release.yml`, environment `npm-publish`.
2. **Publishing access**: "Require two-factor authentication and disallow
   tokens" — CI publishes via the trusted publisher, humans can still
   `--publish-local` interactively with OTP, and no token can ever publish.

In the GitHub repo, create the `npm-publish` environment (Settings →
Environments); optionally add required reviewers to gate publishes further.

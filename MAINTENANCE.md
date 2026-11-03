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

CI stages packages; maintainers approve them on npm with 2FA. Staging requires
Node 22.14+ and npm 11.15+ (CI uses Node 24).
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

1. Run `bun run release` on main. It checks published versions and channel
   ordering, runs the gates, pushes a release commit/tag and creates a draft
   GitHub release. `--dry-run` checks the flow without pushing.
2. Edit and publish the GitHub release. Mark prereleases as GitHub pre-releases.
3. Approve the GitHub `npm-publish` environment. CI stages `@langfuse/cli` and
   `langfuse-cli` from one build, with provenance.
4. Review both packages in npm's **Staged Packages** tab and approve with 2FA.
   GitHub approval permits staging only; npm approval makes the packages public.

Approve releases in version order; reject obsolete pending stages. Approving
an older stage later can move `latest` or `beta` backwards. The two package
approvals are separate operations. After approval, verify both packages:

```sh
npm view @langfuse/cli@latest version gitHead
npm view langfuse-cli@latest version gitHead
```

Stable releases use `latest`; prereleases use `alpha`, `beta` or `rc`.
Use the corresponding tag in the verification commands.

### Retries

Pending stages reserve their versions and are invisible to OIDC, so duplicate
uploads fail. Inspect them on npm, approve or reject with 2FA, then rerun the
failed job. Already-published packages are skipped only if their source commit
matches, allowing a partial dual release to finish.

Manual retries must run at the release tag, which must contain the updated
workflow, have a published GitHub release and be on main:

```sh
gh workflow run release.yml --repo langfuse/langfuse-cli --ref vX.Y.Z
```

The workflow ref/SHA must match the build for provenance. Tags with the old
direct-publish workflow need a new release; running from main cannot fix them.

### Betas and local staging

Actions → **Beta release** stages only `@langfuse/cli`; `dry_run` defaults to
true. Versions use the source's next minor (or explicit beta base) and the run
ID, e.g. `1.4.0-beta.<run-id>`. Reruns keep the same version; new runs get a new
one. New betas must exceed `latest`. Smaller manually numbered betas on the
same channel are rejected before release cuts. Prefer the Beta workflow for
betas and tagged `rc` releases before stable.

`bun run release -- --publish-local` stages from this machine with npm login
and the same build gates. It does not commit or tag; approve separately on npm.
`--tag` overrides the local dist-tag; `--allow-dirty` is for script testing only.
CI is preferred for provenance.

### Publisher configuration

Configure stage-only GitHub trusted publishing on npm:

| Package | Repository | Workflow | Environment |
| --- | --- | --- | --- |
| Both packages | `langfuse/langfuse-cli` | `release.yml` | `npm-publish` |
| `@langfuse/cli` | `langfuse/langfuse-cli` | `beta-release.yml` | `npm-publish-beta` |

Allow **npm stage publish**, disable **npm publish**, and require 2FA with
bypass tokens disallowed. Maintainers need npm write access and 2FA.
Keep required reviewers on both GitHub environments; allow `v*` tags for
`npm-publish` and intended source branches for `npm-publish-beta`.
Restrict release-tag creation to maintainers.

### Legacy npm deprecation notice

The compatibility tarball is functional but its npm README directs users to
`@langfuse/cli`. After both packages for a version are verified, an
authenticated npm owner may also attach npm's install-time notice:

```sh
npm deprecate 'langfuse-cli@<version>' \
  'Renamed to @langfuse/cli. v2 will only be published there. Migration: https://github.com/langfuse/langfuse-cli#readme'
```

The workflow does not run `npm deprecate`: trusted publishing authenticates
package publication, while registry metadata changes remain an explicit owner
operation. At v2, remove the compatibility staging/publish steps, publish only
`@langfuse/cli`, and deprecate the complete legacy version range. Never
unpublish the old artifacts.

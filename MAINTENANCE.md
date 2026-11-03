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

CI stages packages; a maintainer approves them on npm with 2FA before they go
live. Builds use Bun; staging requires Node 22.14+ and npm 11.15+ (CI uses
Node 24). See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

```sh
bun run release
```

1. **Cut** (local, interactive): checks main/origin, CI and version policy, runs
   all gates, then pushes a release commit and tag and opens a draft GitHub
   release. It checks published versions and both packages' channel ordering
   before changing files; pending npm stages are not visible to this check.
2. **Publish the GitHub release** after editing its notes. Approve GitHub's
   protected `npm-publish` environment when requested.
3. **Stage in CI**: `release.yml` verifies the tag/version binding, main ancestry,
   prerelease flag, release ordering, tests, conformance and tarballs. It runs
   `npm stage publish` for `@langfuse/cli`, then `langfuse-cli`, using OIDC with
   provenance. A green job means staged or already published.
4. **Review and approve on npm** using the Staged Packages tab and 2FA. GitHub
   environment approval only authorizes staging. Verify publication afterward.

Both packages come from one build with identical `bin/`, `dist/`, version and
executable. The compatibility package gets its migration README. Stable
versions use `latest`; alpha/beta/rc use their respective dist-tags. Tagged
prereleases must be marked as GitHub pre-releases.

### Approval and verification

In npmjs.com's **Staged Packages** tab, inspect the version, tag, contents and
provenance, then approve both names. Approve releases in version order: an older
pending stage can move a dist-tag backwards if approved after a newer release.
Reject obsolete pending stages instead of approving them.
The two package approvals are separate operations.

Alternatively, use npm's own commands (stage IDs are also in CI upload logs):

```sh
npm stage list @langfuse/cli
npm stage list langfuse-cli
npm stage view <stage-id>
npm stage approve <stage-id>
```

After approval, check that both versions and source commits match the release:

```sh
npm view @langfuse/cli@latest version gitHead
npm view langfuse-cli@latest version gitHead
```

Use `@beta`, `@alpha` or `@rc` for prereleases.

### Retries and existing tags

A pending stage reserves its version. OIDC cannot inspect or approve stages,
so a duplicate upload **fails** rather than guessing whether it is safe to
skip. Review and approve the intended pending stage, or reject it with
`npm stage reject <stage-id>` (2FA), then rerun the failed job. The existing
release guard skips published versions only when their source commit matches,
so a partial dual release can finish without republishing the first package.

For a tag containing this staged-publishing workflow, rerun its failed job or
dispatch the Release workflow **at that tag** (replace `vX.Y.Z`):

```sh
gh workflow run release.yml --repo langfuse/langfuse-cli --ref vX.Y.Z
```

The tag must have a published GitHub release and its commit must be on main.
The workflow ref, SHA and checked-out source must agree for npm provenance.
Dispatching from main to build an older tag is unsupported. Older tags such as
`v1.3.0` still contain the direct-publish workflow; cut a new release after this
change is merged rather than retrying those jobs.

### Beta releases

Actions → **Beta release** → Run workflow stages only `@langfuse/cli` (both
package tarballs are still checked). `dry_run` defaults to true and stops before
staging. The version uses the source's next minor (or explicit beta base) plus
the GitHub run ID: `1.4.0-beta.<run-id>`. This avoids collisions with invisible
pending stages. Reruns keep their version; new runs get a new version. Approve
on npm as above, then verify `@langfuse/cli@beta`. New betas must be newer than
`latest`. Tagged betas share this channel: after a run-ID beta, a smaller manual
beta number is rejected before the release cut. Prefer this workflow for betas
and tagged `rc` releases when preparing a stable release.

### Local staging and dry runs

```sh
bun run release -- --dry-run
bun run release -- --publish-local
```

The first command tests the cut flow without pushing. Add `--allow-dirty` only
when testing the release script itself.

The local escape hatch now **stages only**, despite the existing flag name.
It requires npm >=11.15.0 and npm login, runs the same gates and pack checks,
and asks for staging confirmation. Approve separately on npm with 2FA. It does
not commit or tag; CI is preferred for provenance. `--tag <dist-tag>` remains
a local-only override.
If interrupted, inspect pending stages before starting another release.

### One-time npm/GitHub configuration (required)

On **both** npm packages, configure the GitHub trusted publisher:

- Organization `langfuse`, repository `langfuse-cli`.
- Workflow `release.yml`, environment `npm-publish`.
- Allow **npm stage publish**; disable **npm publish**. Dist-tag management
  permission is not needed: approval applies the tag selected when staging.
- Publishing access: **Require two-factor authentication and disallow bypass
  2FA tokens**. Maintainers need npm write access and 2FA for approval.

For `@langfuse/cli`, also use stage-only permissions for the `beta-release.yml` /
`npm-publish-beta` connection. Keep required reviewers on both GitHub environments.
Allow `v*` tags on `npm-publish`; allow the intended source branches on
`npm-publish-beta`. Restrict creation of release tags
to maintainers. Existing package names need no bootstrap.

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

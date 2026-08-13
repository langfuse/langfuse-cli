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

## Releases

```sh
bun run release
```

This interactively selects the package version, verifies it is not already on
npm, checks npm auth and registry, typechecks, runs both test suites, rebuilds
the CLI, checks npm package contents with `npm pack --dry-run`, shows the
post-build git status, then asks before publishing.

To test the flow without publishing:

```sh
bun run release -- --dry-run
```

Dry-run still runs the full reproducible build path and restores the package
version before exiting. Generated `dist/` artifacts remain ignored.

If testing local changes to the release script itself, add `--allow-dirty`.
Never use `--allow-dirty` for a real publish.

The release script does not commit or tag automatically. After a successful
publish, create the release commit and tag intentionally.

### Release candidates

Publish a release candidate with an explicit version and npm dist-tag:

```sh
bun run release -- --version 1.0.0-rc.0 --tag rc
```

For prerelease versions, the tag is also inferred from the first prerelease
identifier (`1.0.0-rc.0` → `rc`). Stable versions default to `latest`.

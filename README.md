<img width="2400" height="600" alt="hero-b" src="https://github.com/user-attachments/assets/85dcdba4-c037-4e3e-9f20-e39cde0a15ec" />

# langfuse-cli

Interact with the [Langfuse](https://langfuse.com) API from the command line.

## Install

```sh
# Run directly
npx langfuse-cli api <resource> <action>
# or
bunx langfuse-cli api <resource> <action>

# Or install globally
npm i -g langfuse-cli
# or
bun add --global langfuse-cli
langfuse api <resource> <action>
```

## Configuration

Use an `.env` file (recommended, takes precedence):

```sh
langfuse --env .env api prompts list
```

You can get the values from your project settings. The `.env` file should contain:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com  # optional, this is the default (LANGFUSE_BASE_URL also supported)
```

Alternatively, export env vars or pass inline flags:

```sh
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com
langfuse api prompts list

# or inline
langfuse --public-key pk-lf-... --secret-key sk-lf-... api prompts list
```

## Usage

```sh
# Discover resources naturally
langfuse api help
langfuse api help prompts
langfuse api help prompts create

# Machine-readable discovery (legacy command alias)
langfuse api schema --json
langfuse api __schema --json

# List traces
langfuse api traces list --limit 10

# Get a specific trace
langfuse api traces get <trace-id>

# JSON output (for piping/scripting)
langfuse api traces list --limit 5 --json

# Preview curl command
langfuse api traces list --limit 5 --curl

# Prompts
langfuse api prompts list
langfuse api prompts get my-prompt
langfuse api prompts create --body-json '{"name":"my-prompt","type":"text","prompt":"Hello {{name}}"}'

# Datasets
langfuse api datasets list
langfuse api dataset-items list --dataset-name my-dataset

# Scores
langfuse api score-v2s get-scores --limit 20

# Use an API snapshot compatible with an older self-hosted deployment
langfuse --api-version 3.150.0 api traces list

# Detect the server version through /api/public/health
langfuse --api-version auto api traces list
```

## Agent Usage

The latest Langfuse skill lives in [`langfuse/skills`](https://github.com/langfuse/skills). Print the current version with:

```sh
langfuse get-skill
```

This fetches the latest skill from GitHub, so it stays up to date. Pipe it into an agent's context or include it in a system prompt.

## API Reference

See the full [Langfuse API Reference](https://api.reference.langfuse.com/).

## OpenAPI conformance suite

The version-pinned black-box suite lives in [`conformance/`](conformance/README.md). It invokes every operation through the real CLI across historical Langfuse specs. Active operations make one minimally valid mocked API call; operations marked `deprecated: true` must fail before any network request.

```sh
bun test
bun run conformance:all
```

`bun test` verifies the generator, schemas, serialization, capture oracle, deprecation policy, and legacy CLI compatibility. `bun run conformance:all` builds the package and checks every operation through the native CLI using its lossless JSON input path. CI runs both.

## Native OpenAPI contracts

The CLI is implemented in TypeScript and runs natively on Bun. It has zero external runtime dependencies and never parses OpenAPI during invocation.

Builds compile committed OpenAPI snapshots into compact versioned contracts under ignored `dist/contracts/`. Catalog entries record the exact committed hash; snapshots with explicit local annotations also record the upstream hash and modification name. Generated contracts are packaged on npm but are not committed.

```sh
# Build the Bun CLI and all versioned contracts
bun run build

# Add or refresh an immutable upstream snapshot
bun run conformance:sync -- --version <version>

# Add a stable release snapshot, update metadata, and verify it
bun run conformance:add-version -- v4.11.0
```

`--body-json` and `--body-file` provide a lossless input path for nested objects, arrays, unions, and free-form JSON. Simple historical field flags remain supported where they were previously expressible.

## Release

```sh
bun run release
```

This interactively selects the package version, verifies it is not already on npm, checks npm auth/registry, typechecks, runs both test suites, rebuilds the CLI, checks the npm package contents with `npm pack --dry-run`, shows the post-build git status, then asks before publishing to npm.

To test the flow without publishing:

```sh
bun run release -- --dry-run
```

Dry-run still runs the full reproducible build path and restores the package version before exiting. Generated `dist/` artifacts remain ignored.

If you are testing local changes to the release script itself, add `--allow-dirty`. Do not use `--allow-dirty` for a real publish.

The release script does not commit or tag automatically. After a successful publish, create the release commit/tag intentionally.

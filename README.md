<img width="2400" height="600" alt="hero-b" src="https://github.com/user-attachments/assets/85dcdba4-c037-4e3e-9f20-e39cde0a15ec" />

# langfuse-cli

Interact with the [Langfuse](https://langfuse.com) API from the command line.

## Install

```sh
# Run directly
npx langfuse-cli api <resource> <action>
bunx langfuse-cli api <resource> <action>

# Or install globally
npm i -g langfuse-cli
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
# Discover all resources
langfuse api __schema

# List actions for a resource
langfuse api traces --help

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
langfuse api prompts get --name my-prompt

# Datasets
langfuse api datasets list
langfuse api dataset-items list --dataset-name my-dataset

# Scores
langfuse api score-v2s get-scores --limit 20
```

## Agent Usage

The latest Langfuse skill lives in [`langfuse/skills`](https://github.com/langfuse/skills). Print the current version with:

```sh
langfuse get-skill
```

This fetches the latest skill from GitHub, so it stays up to date. Pipe it into an agent's context or include it in a system prompt.

## API Reference

See the full [Langfuse API Reference](https://api.reference.langfuse.com/).

## OpenAPI Patch Script

The bundled `openapi.yml` is post-processed by `scripts/patch-openapi.ts` to flatten discriminated unions (`oneOf` with `allOf` branches) into plain objects. This is needed because specli can only generate CLI flags from flat `type: object` schemas — it doesn't handle `oneOf`/`allOf`. Without the patch, endpoints like `prompts create` produce zero flags.

The patch runs automatically as part of `bun run build`. To fetch a fresh spec and patch it:

```sh
# From cloud (default)
bun run refetch-openapi

# From a custom URL (e.g. local dev server)
bun run patch-openapi -- --refetch --openapi_url http://localhost:3000/generated/api/openapi.yml

# Patch only (no fetch)
bun run patch-openapi
```

## Release

```sh
bun run release
```

This interactively bumps the package version, runs tests, rebuilds the CLI, checks the npm package contents with `npm pack --dry-run`, then asks before publishing to npm.

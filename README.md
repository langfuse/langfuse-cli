<img width="2400" height="600" alt="hero-b" src="https://github.com/user-attachments/assets/85dcdba4-c037-4e3e-9f20-e39cde0a15ec" />

# langfuse-cli

Interact with the [Langfuse](https://langfuse.com) API from the command line.

## Install

```sh
# Run directly
npx langfuse-cli api <resource> <action>
# or
bunx --bun langfuse-cli api <resource> <action>

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

# List observations
langfuse api observations list --limit 10

# List observations for a specific trace
langfuse api observations list --trace-id <trace-id>

# JSON output (for piping/scripting)
langfuse api observations list --limit 5 --json

# Preview curl command
langfuse api observations list --limit 5 --curl

# Prompts
langfuse api prompts list
langfuse api prompts get my-prompt
langfuse api prompts create --body-json '{"name":"my-prompt","type":"text","prompt":"Hello {{name}}"}'

# Datasets
langfuse api datasets list
langfuse api dataset-items list --dataset-name my-dataset

# Scores
langfuse api scores list --limit 20

# Use an API snapshot compatible with an older self-hosted deployment
langfuse --api-version 3.150.0 api traces list

# Detect the server version through /api/public/health
langfuse --api-version auto api prompts list
```

Canonical command resources come from API paths and use concise REST actions.
OpenAPI tags and explicit route versions remain accepted aliases, for example
`scores-v3 list` for the canonical `scores list`. Verbose OpenAPI `operationId`
values remain available in `api schema --json` but are never required as CLI
commands.

`--body-json` and `--body-file` provide a lossless input path for nested
objects, arrays, unions, and free-form JSON. Simple request-body fields also
get generated kebab-case flags (for example `--object-id` for the `objectId`
field) consistent with query-parameter flags; wire names in the request are
never affected.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Successful API response or local command |
| 1 | Unexpected internal failure |
| 2 | Invalid command or input (usage); no request sent |
| 3 | Missing or invalid configuration/credentials; no request sent |
| 4 | Network, DNS, TLS, or timeout failure reaching the host |
| 5 | The API responded with a non-success HTTP status (response is still printed) |
| 6 | Local file or bundled-contract failure |

## Agent Usage

The latest Langfuse skill lives in [`langfuse/skills`](https://github.com/langfuse/skills). Print the current version with:

```sh
langfuse get-skill
```

This fetches the latest skill from GitHub, so it stays up to date. Pipe it into an agent's context or include it in a system prompt.

## API Reference

See the full [Langfuse API Reference](https://api.reference.langfuse.com/).

## Implementation

The CLI is implemented in TypeScript and runs on Node.js 20+ or Bun. It has zero external runtime dependencies and never parses OpenAPI during invocation.

See [MAINTENANCE.md](MAINTENANCE.md) for build, API snapshot, testing, and
release workflows. The version-pinned black-box suite is documented separately
in [`conformance/README.md`](conformance/README.md).

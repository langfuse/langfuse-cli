# langfuse-cli

<!-- Test comment: Langfuse tracing integration verification -->

Interact with the [Langfuse](https://langfuse.com) API from the command line and automate Claude Code tracing setup.

## Install

```sh
# Run directly
npx langfuse-cli api <resource> <action>
bunx langfuse-cli api <resource> <action>

# Or install globally
npm i -g langfuse-cli
langfuse api <resource> <action>
```

## Claude Code Tracing Automation

Use these commands to automate the Claude Code hooks integration and git-linked trace manifests:

```sh
# Enable tracing in the current repo
langfuse enable

# Disable tracing in the current repo
langfuse disable

# Inspect setup health
langfuse status

# List trace links from local manifests
langfuse traces --limit 20
```

What `langfuse enable` configures:

- Global Claude settings in `~/.claude/settings.json`:
  - `Stop` hook command: `python3 ~/.claude/hooks/langfuse_hook.py`
  - `PostToolUse` hook command for `Bash`: `python3 ~/.claude/hooks/langfuse_git_commit_hook.py`
- Hook scripts in `~/.claude/hooks/`
- Per-repo config in `<repo>/.claude/settings.local.json` with:
  - `TRACE_TO_LANGFUSE=true`
  - `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`
- Git ignore entry for `.langfuse/current-session.json` (manifests remain commit-friendly)

The integration is opt-in per repository via `.claude/settings.local.json`.

### Git-Linked Manifest Format

After Claude Code produces traces and a successful `git commit` runs through the Bash tool, a small manifest is written to `.langfuse/traces/<session-id>.json`:

```json
{
  "schema_version": 1,
  "langfuse": {
    "trace_id": "trc_...",
    "trace_url": "https://cloud.langfuse.com/trace/trc_...",
    "session_id": "claude-session-id",
    "host": "https://cloud.langfuse.com"
  },
  "git": {
    "commit_sha": "abc123...",
    "commit_url": "https://github.com/org/repo/commit/abc123...",
    "commit_message": "Add feature",
    "branch": "main",
    "remote_url": "git@github.com:org/repo.git"
  },
  "created_at": "2026-02-20T12:34:56.000000+00:00"
}
```

The manifest intentionally contains only trace and commit metadata (no prompts/transcript payloads), keeping repository history small and reducing sensitive-data exposure.

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

`langfuse enable` reads credentials from:

1. Global flags: `--public-key`, `--secret-key`, `--host`
2. Environment variables: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`/`LANGFUSE_HOST`
3. Interactive prompt fallback (unless `--yes` or `--non-interactive` is set)

## Usage

```sh
# Setup automation
langfuse enable --dry-run
langfuse enable --non-interactive --public-key pk-lf-... --secret-key sk-lf-...
langfuse disable --dry-run
langfuse disable --remove-scripts
langfuse status --json
langfuse traces --limit 10

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

A skill file is included for teaching AI agents how to use the CLI. Print it with:

```sh
langfuse get-skill
```

Pipe it into an agent's context or include it in a system prompt.

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

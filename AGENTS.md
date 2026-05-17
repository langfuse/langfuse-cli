# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is `langfuse-cli` — a CLI tool for interacting with the Langfuse API. It wraps the [`specli`](https://www.npmjs.com/package/specli) library which auto-generates CLI commands from a bundled OpenAPI specification (`openapi.yml`).

### Prerequisites

- **Bun** — required for build scripts (`bun run build`, `bun run patch-openapi`).
- **Node.js >= 20** — runtime for the built CLI (`bin/langfuse.mjs`).

### Key commands

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` (fetches latest OpenAPI spec + bundles `src/cli.ts` → `dist/cli.js`) |
| Run CLI | `node bin/langfuse.mjs` |
| Patch OpenAPI only | `bun run patch-openapi` |
| Refetch OpenAPI | `bun run refetch-openapi` |

### Development notes

- There are no automated tests, linter, or formatter configured in this project.
- The build step (`bun run build`) fetches the OpenAPI spec from `https://cloud.langfuse.com/generated/api/openapi.yml` — it requires network access.
- To test the CLI against the Langfuse API you need `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` env vars (or pass `--public-key` / `--secret-key` flags). See `.env.default` for local dev defaults.
- The `--curl` flag on any API command previews the curl command without executing it, useful for verifying command construction without credentials.
- The project has no lockfile committed; `bun install` generates `bun.lock` locally.

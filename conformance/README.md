# Langfuse CLI OpenAPI conformance suite

Language-neutral, version-pinned acceptance tests for the native TypeScript CLI. The oracle does not import the runtime request builder.

## What is tested

The primary test invokes every operation in every cataloged spec through the real CLI. For active operations it:

- generates one minimally valid invocation from the committed OpenAPI source
- starts a local mock HTTP server with a response generated from that operation
- runs the CLI as a subprocess against the mock host
- compares the received method, path, query, headers, authentication, and JSON body
- compares the CLI's response status, body, and exit status

For operations marked `deprecated: true`, it instead verifies exit code 2, a helpful error on stderr, and zero network requests.

The black-box oracle does not share request-building code with the CLI. `bun run conformance:all` checks all 479 operations across 5 pinned snapshots through the actual CLI using lossless `--body-json` input, including pre-network rejection for deprecated operations.

Supporting unit tests verify immutable spec hashes, valid sampling, serialization, naming, invocation generation, and the capture runner itself.

OpenAPI cannot describe database setup, generated IDs, cross-request bindings, cleanup, licenses, or feature flags. Those stateful live workflows require a small reviewed scenario overlay; they are not silently invented by this generator.

## Pinned specs

| Langfuse | Paths | Operations |
|---|---:|---:|
| 3.50.0 | 44 | 68 |
| 3.150.0 | 55 | 86 |
| 3.200.0 | 61 | 98 |
| 3.225.3 | 69 | 113 |
| 4.10.0 | 70 | 114 |

Each source file is downloaded by immutable commit and verified against the SHA-256 in `catalog.json`. Tests are network-free after sync.

Some pinned specs use the JSON Schema `const` keyword while declaring OpenAPI 3.0.1. `swagger-parser` correctly reports those sources as invalid OAS 3.0 documents. The catalog records this as `oas3.0-const-keyword`; request sampling still preserves and tests the constraint with the independent JSON Schema validator.

## Files

```text
catalog.json                 immutable Git refs, commits, hashes, known source issues
specs/<version>/openapi.yml  committed source snapshots
goldens/<version>.json       reviewed command-name goldens (resource, action, aliases)
src/                         compiler, serializers, invocation, capture runner
tests/                       compiler, validator, and runner tests
```

Command names are not derived by the oracle: it reads the committed goldens,
so a regression in the CLI's naming heuristics fails the suite instead of
moving both sides at once. Regenerate goldens with `bun run goldens:update`
after an intentional naming change and review the diff.

## Commands

```sh
# Generator, schema, serializer, capture, and invocation tests
bun test

# Build and check every endpoint through the lossless native CLI
bun run conformance:all

# Re-download pinned bytes and verify their hashes
bun run conformance:sync
```

## CI gate

GitHub Actions runs both commands for every pull request, merge queue entry, and push to `main`:

```sh
bun test
bun run conformance:all
```

The required check name is **Test and verify OpenAPI conformance**. The interactive release script repeats the checks before building or publishing.

## Run a focused check

```sh
bun run conformance:run -- \
  --version 3.225.3 \
  --operation prompts_create \
  -- bun bin/langfuse.mjs --api-version 3.225.3
```

Useful filters:

```sh
--operation prompts_create
--max 20
--fail-fast
```

The command after the second `--` is treated as an external black-box executable.

## Add a version

```sh
bun run conformance:add-version -- v4.11.0
```

The command accepts only stable semantic release tags. It verifies the published GitHub release, resolves the tag to an immutable commit, downloads the exact OpenAPI bytes, records their SHA-256, checks both compilers, updates the catalog and this table, then runs typecheck, tests, build, and focused black-box conformance. If validation fails, it restores the catalog, spec directory, and documentation.

Preview without writing files:

```sh
bun run conformance:add-version -- v4.11.0 --dry-run
```

Review the resulting source diff and live-test added or changed endpoints before committing. Never catalog mutable `main` or `latest`.

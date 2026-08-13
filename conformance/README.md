# Langfuse CLI OpenAPI conformance suite

Language-neutral, version-pinned acceptance tests for the native TypeScript CLI. The oracle does not import the runtime request builder.

## What is tested

The primary test fake-calls every operation in every cataloged spec through the real CLI. For each operation it:

- generates one minimally valid invocation from the untouched OpenAPI source
- starts a local mock HTTP server with a response generated from that operation
- runs the CLI as a subprocess against the mock host
- compares the received method, path, query, headers, authentication, and JSON body
- compares the CLI's response status, body, and exit status

The black-box oracle does not share request-building code with the CLI. `bun test` currently attempts all 792 operations across 9 pinned snapshots using the historical field-flag adapter. Operations that require lossless JSON bodies remain an explicit compatibility baseline; any additional failure fails the test. The native `contract-v1` adapter passes all 792 operations through `--body-json`.

Supporting unit tests verify immutable spec hashes, valid sampling, serialization, naming, adapters, and the capture runner itself.

OpenAPI cannot describe database setup, generated IDs, cross-request bindings, cleanup, licenses, or feature flags. Those stateful live workflows require a small reviewed scenario overlay; they are not silently invented by this generator.

## Pinned specs

| Langfuse | Paths | Operations |
|---|---:|---:|
| 3.0.0 | 29 | 39 |
| 3.50.0 | 44 | 68 |
| 3.100.0 | 49 | 77 |
| 3.150.0 | 55 | 86 |
| 3.176.0 | 60 | 96 |
| 3.200.0 | 61 | 98 |
| 3.212.0 | 64 | 101 |
| 3.216.0 | 69 | 113 |
| 4.10.0 | 70 | 114 |

Each source file is downloaded by immutable commit and verified against the SHA-256 in `catalog.json`. Tests are network-free after sync.

Some pinned specs use the JSON Schema `const` keyword while declaring OpenAPI 3.0.1. `swagger-parser` correctly reports those sources as invalid OAS 3.0 documents. The catalog records this as `oas3.0-const-keyword`; request sampling still preserves and tests the constraint with the independent JSON Schema validator.

## Files

```text
catalog.json                 immutable Git refs, commits, hashes, known source issues
policy.json                  implementation adapters; not API truth
specs/<version>/openapi.yml  untouched upstream snapshots
src/                         compiler, serializers, adapters, capture runner
tests/                       compiler, validator, and runner tests
```

## Commands

```sh
# Generator, schema, serializer, capture, and compatibility tests
bun test

# Build and fake-call every endpoint through the lossless native CLI
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

## Run a focused current-CLI check

```sh
bun run conformance:run -- \
  --version 3.212.0 \
  --adapter specli-v0 \
  --current-cli
```

The adapter name is retained because it describes the old field-flag grammar. The runner builds the native current source and compiles the selected untouched spec into a temporary runtime contract.

Useful filters:

```sh
--operation prompts_create
--max 20
--fail-fast
```

Failures identify current limitations inline: raw union bodies, complex body flags, response exit codes, naming mismatches, or missing version selection.

## Run the lossless native contract

The native adapter uses lossless JSON body input via `--body-json`:

```sh
bun run conformance:run -- \
  --version 4.10.0 \
  --adapter contract-v1 \
  -- bun bin/langfuse.mjs --api-version 4.10.0
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

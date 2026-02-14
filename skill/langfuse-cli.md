# Langfuse CLI Skill

Use the `langfuse` CLI to interact with the Langfuse API from the command line.

## Install

```sh
# Run directly
npx langfuse-cli api <resource> <action>
bunx langfuse-cli api <resource> <action>

# Or install globally
npm i -g langfuse-cli
langfuse api <resource> <action>
```

## Setup

Set environment variables:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com  # optional, this is the default EU region
```

Or pass inline:

```bash
langfuse --public-key pk-lf-... --secret-key sk-lf-... --host https://cloud.langfuse.com api <resource> <action>
```

## Discovery

```bash
# List all resources and auth info
langfuse api __schema

# List actions for a resource
langfuse api <resource> --help

# Show args/options for a specific action
langfuse api <resource> <action> --help

# Preview the curl command without executing
langfuse api <resource> <action> --curl
```

## Common Workflows

### Traces

```bash
langfuse api traces list --limit 10
langfuse api traces get <trace-id>
```

### Prompts

```bash
langfuse api prompts list
langfuse api prompts get --name my-prompt
langfuse api prompts create --type text --name my-prompt --prompt "Hello {{name}}"
# Update a prompt = create a new version with the same name
langfuse api prompts create --type text --name my-prompt --prompt "Hello {{name}}, welcome!"
```

### Datasets

```bash
langfuse api datasets list
langfuse api dataset-items list --dataset-name my-dataset
```

### Scores

```bash
langfuse api scores list --limit 20
langfuse api score-configs list
```

### Sessions

```bash
langfuse api sessions list --limit 10
langfuse api sessions get <session-id>
```

## Tips

- Use `--json` for machine-readable JSON output
- Use `--curl` to preview the HTTP request without executing it
- Pagination: use `--limit` and `--page` on list endpoints
- All list commands support filtering — check `<resource> <action> --help` for available options
- Prefer `observations-v2s` over `observations` — the v2 endpoint returns richer data
- Prefer `metrics-v2s` over `metrics` — the v2 endpoint returns richer data

## Langfuse Documentation

To learn more about Langfuse concepts, search or fetch docs as markdown:

```bash
# Index of all doc pages
curl -s https://langfuse.com/llms.txt

# Search docs (only if llms.txt doesn't have what you need — responses are large)
curl -s "https://langfuse.com/api/search-docs?query=How+do+I+trace+LangGraph+agents"

# Fetch a specific doc page as markdown (use full paths from llms.txt)
curl -s https://langfuse.com/docs/observability/overview.md        # Tracing & observability
curl -s https://langfuse.com/docs/api-and-data-platform/overview.md  # API overview
```

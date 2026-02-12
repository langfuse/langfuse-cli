# Langfuse CLI Skill

Use the `langfuse` CLI to interact with the Langfuse API from the command line.

## Setup

Set environment variables:
```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com  # optional, this is the default EU region
```

Or pass inline:
```bash
langfuse --public-key pk-lf-... --secret-key sk-lf-... --host https://cloud.langfuse.com <resource> <action>
```

## Discovery

```bash
# List all resources and auth info
langfuse __schema

# List actions for a resource
langfuse <resource> --help

# Show args/options for a specific action
langfuse <resource> <action> --help

# Preview the curl command without executing
langfuse <resource> <action> --curl
```

## Common Workflows

### Traces
```bash
langfuse traces list --limit 10
langfuse traces get <trace-id>
```

### Prompts
```bash
langfuse prompts list
langfuse prompts get --name my-prompt
langfuse prompts create --type text --name my-prompt --prompt "Hello {{name}}"
```

### Datasets
```bash
langfuse datasets list
langfuse dataset-items list --dataset-name my-dataset
```

### Scores
```bash
langfuse scores list --limit 20
langfuse score-configs list
```

### Sessions
```bash
langfuse sessions list --limit 10
langfuse sessions get <session-id>
```

## Tips

- Use `--json` for machine-readable JSON output
- Use `--curl` to preview the HTTP request without executing it
- Pagination: use `--limit` and `--page` on list endpoints
- All list commands support filtering — check `<resource> <action> --help` for available options

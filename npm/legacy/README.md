# `langfuse-cli` is deprecated

The npm package has moved to
[`@langfuse/cli`](https://www.npmjs.com/package/@langfuse/cli). The executable
remains `langfuse`.

Run the current package directly:

```sh
npx @langfuse/cli api <resource> <action>
```

For a global installation, remove the legacy package first because both
packages provide the same `langfuse` executable:

```sh
npm uninstall -g langfuse-cli
npm install -g @langfuse/cli
```

See the [Langfuse CLI documentation](https://github.com/langfuse/langfuse-cli#readme)
for authentication, usage, and other installation options.

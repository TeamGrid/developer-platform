# @teamgrid/mcp-server

Optional read-only stdio MCP adapter for TeamGrid. It is deliberately a thin
consumer of `@teamgrid/api-client`: no MCP-specific API, credential, database,
remote session, or write path exists.

```json
{
  "mcpServers": {
    "teamgrid": {
      "command": "teamgrid-mcp",
      "args": ["--profile", "default"]
    }
  }
}
```

Run `teamgrid auth login` first. The adapter reads the same OS keychain profile
as the CLI. `TEAMGRID_API_TOKEN` and `TEAMGRID_API_BASE_URL` may be supplied to
the process for ephemeral CI/local use.

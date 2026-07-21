# @teamgrid/mcp-server

Optional read-only stdio MCP adapter for TeamGrid. It is deliberately a thin
consumer of `@teamgrid/api-client`: no MCP-specific API, credential, database,
remote session, or write path exists.

```json
{
  "mcpServers": {
    "teamgrid": {
      "command": "teamgrid-mcp",
      "args": ["--profile", "default", "--tool-profile", "core"]
    }
  }
}
```

Run `teamgrid auth login` first. The adapter reads the same OS keychain profile
as the CLI. `TEAMGRID_API_TOKEN` and `TEAMGRID_API_BASE_URL` may be supplied to
the process for ephemeral CI/local use.

The default `core` profile exposes 15 bounded reads for workspace, projects,
tasks, time entries, lists, tags, products, and product groups. Product purchase
prices are never included without the finance overlay, which the MCP preset does
not grant. Use `collaboration` for contact, call-note, contact-group, and user
reads; `governance` for webhook, service, and custom-field-definition
reads; or `all` for the explicit 29-tool union. Project statements and webhook
delivery history remain forbidden in every MCP profile. The adapter does not
expose write or secret-bearing operations.

The high-volume change feed is forbidden in every MCP profile. It is a synchronization
primitive for API, SDK, and CLI consumers, not a bounded interactive model tool. Per-resource
custom-field values, project templates and instantiation status, and planned-work schedules and
operation status are also forbidden in every profile because they contain sensitive workflow or
workload data. Even `all` does not register or advertise any of these operations. Custom-field
*definition* reads remain the narrow exception in `governance`; all writes remain forbidden.
The release gate checks this explicit decision against the same 23-resource OpenAPI contract used
by the SDK and CLI, so adding a resource type cannot accidentally create an MCP tool or disappear
from the supported synchronization surfaces.

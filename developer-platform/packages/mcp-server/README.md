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
as the CLI, including profiles stored in Windows Credential Manager. The MCP
stdio process never opens a browser itself. `TEAMGRID_API_TOKEN` and
`TEAMGRID_API_BASE_URL` may be supplied to the process for ephemeral CI/local
use.

The default `core` profile exposes 15 bounded reads for workspace, projects,
tasks, time entries, lists, tags, products, and product groups. Product purchase
prices are removed from MCP results even when the selected credential has a
finance overlay. Use `collaboration` for contact, call-note, contact-group, and user
reads; `governance` for webhook, service, and custom-field-definition
reads; or `all` for the explicit 29-tool union. Project statements and webhook
delivery history remain forbidden in every MCP profile. The adapter does not
expose write or secret-bearing operations.
Time-entry billing state is also forbidden in every profile because it is a
finance-sensitive lock decision, not an interactive read tool.

`--allow-tool` narrows the selected profile to exact registered tool names;
`--deny-tool` removes exact tools. Both options may be repeated or receive a
comma-separated list. An allow filter cannot enable a tool outside the selected
profile, unknown names fail startup, and overlapping allow/deny entries are
rejected. `TEAMGRID_MCP_ALLOW_TOOLS` and `TEAMGRID_MCP_DENY_TOOLS` provide the
same narrowing controls for isolated process environments.

```sh
teamgrid-mcp --profile default --tool-profile core \
  --allow-tool teamgrid_workspace_get,teamgrid_projects_list

teamgrid-mcp --profile default --tool-profile core \
  --deny-tool teamgrid_time_entries_list,teamgrid_time_entry_get
```

Avoid an allow/deny overlap: list the final desired tools in the allow filter or
use a deny filter by itself.

Every advertised tool has a human-readable title, a strict input schema, a
response-envelope output schema, and read-only/idempotent annotations. API
failures are projected into a bounded structured error containing the stable API
code and, when available, HTTP status, request ID, and retry delay. Unexpected
errors use a fixed message. Authorization headers, bearer credentials, transport
headers, raw causes, and unexpected exception text are never projected.

TeamGrid fields are customer-controlled data. The server instructions tell MCP
hosts to treat results as untrusted content rather than commands: links or text
inside a task, project, contact, or other result must never cause the host to
reveal secrets, broaden scopes or tool filters, or follow additional cursors.

Project and task tools include their stable developer revision. MCP remains intentionally
read-only, so compare-and-set inputs are not part of its curated tool surface.
The two time-entry tools additionally remove `billable`, `billed`, and `billedAt`
from every result. Their input schema does not expose the `billable` or `billed`
filters.

The stable API and SDK expose a high-volume change feed, but it remains intentionally absent from
every MCP profile because it is a synchronization primitive rather than an interactive model
tool. Per-resource
custom-field values, project templates and instantiation status, and planned-work schedules and
operation status are also forbidden in every profile because they contain sensitive workflow or
workload data. Even `all` does not register or advertise any of these operations. Custom-field
*definition* reads remain the narrow exception in `governance`; all writes remain forbidden. The
release gate verifies that the contract, SDK, and CLI expose it consistently while the MCP adapter
keeps it forbidden.

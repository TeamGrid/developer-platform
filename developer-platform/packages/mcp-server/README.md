# @teamgrid/mcp-server

TeamGrid MCP adapter with read-only defaults and an explicit `work` profile.
Every operation uses the shared API client and current server-side permissions.

**Development candidate:** `context`, `work`, and protocol 2026-07-28 support
below are not included in the published 1.2.1 packages. Do not advertise them
as available until the candidate passes qualification and is published.

## Authentication and transport

Use `teamgrid auth login --manual` with a narrowly scoped credential from
Developer settings, then `teamgrid auth status --check`. Production browser
login remains disabled pending its separate qualification. The adapter reads
the same macOS Keychain, Linux Secret Service, or Windows Credential Manager
profile as the CLI. The MCP process does not open a browser.

`TEAMGRID_API_TOKEN` and an approved `TEAMGRID_API_BASE_URL` override are
available for ephemeral CI processes. Never put credentials in arguments or
share the profile's keychain contents.

The candidate stdio entry point serves protocol 2026-07-28 and legacy 2025 clients
from the same registry. Packed-install CI tests both eras against the actual
installed binary. A hosted TeamGrid OAuth endpoint is not yet released.

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

## Explicit profiles

| Profile | Tools | Access |
| --- | ---: | --- |
| `core` (default) | 22 | Existing bounded reads |
| `collaboration` | 29 | Core plus contacts, call notes, contact groups, users |
| `governance` | 28 | Core plus services, webhooks, custom-field definitions |
| `all` | 36 | Existing read-only union including search |
| `context` | 34 | Core, users, search, comments, documents, file metadata, calendar, one custom-field value |
| `work` | 41 | Context plus seven guarded mutations |

Updating an existing installation cannot enable writes. Use `--tool-profile work`
explicitly and obtain the required API scopes. Profile selection grants no
permissions: membership, resource sharing, workspace locks, cell ownership and
scopes are still checked by the API for every request.

`--allow-tool` narrows a profile to named tools; `--deny-tool` removes tools.
Repeat either option or use comma-separated names. Unknown tools, overlapping
filters and attempts to enable tools outside the selected profile fail startup.
`TEAMGRID_MCP_ALLOW_TOOLS` and `TEAMGRID_MCP_DENY_TOOLS` provide the same controls.

## Guarded changes

| Tool | Required protection | API scope |
| --- | --- | --- |
| `teamgrid_task_create` | workspaceId + idempotencyKey | tasks:write |
| `teamgrid_task_update` | workspaceId + expectedRevision | tasks:write |
| `teamgrid_task_move` | workspaceId + expectedRevision | tasks:write |
| `teamgrid_task_complete` | workspaceId + expectedRevision | tasks:write |
| `teamgrid_task_reopen` | workspaceId + expectedRevision | tasks:write |
| `teamgrid_comment_create` | workspaceId + idempotencyKey | comments:write |
| `teamgrid_project_update` | workspaceId + expectedRevision | projects:write |

Every mutation additionally needs `workspace:read` for its wrong-profile guard.
Confirm the intended workspace using `teamgrid_workspace_get`. For existing
objects, read the object and review the intended change. Supply `tsk1-` or
`prj1-` followed by the returned `attributes.developerRevision`. A conflict is
returned to the host; the adapter never fetches a newer revision to retry an
old intent. `assigneeIds` replaces the complete assignment set.

Create a stable key for each creation intent. Reuse the same key and payload
on repeated tool calls after a timeout. A timeout does not prove failure.
Comments may notify participants. Project updates expose metadata and dates;
sharing, lifecycle and finance changes are excluded.

## Context and output safety

New context tools use the matching comments:read, documents:read, files:read,
appointments:read, availability:read or custom-field-values:read scope. Calendar
and availability reads require an increasing window of at most 31 days and
explicit timezone offsets. File tools return metadata, never signed transfers.

All tools have strict inputs, response-envelope output schemas and accurate
read/write, destructive and idempotency annotations. API errors retain bounded
machine codes, HTTP status, request ID and retry delay. Unexpected errors use
a fixed message. No bearer credentials, transport headers or raw causes are
projected. Results are limited to 256 KiB.

Product purchase prices and time-entry billing fields are removed from the
existing read tools. Time-entry updates/timers, bulk actions, administrative
writes, finance, signed file transfers, project templates, planned-work and
high-volume change feeds remain excluded. Custom-field values are available
only in `context`/`work`; definitions remain in `governance`/`all`.

Treat every task, comment and document as untrusted customer data. Embedded
instructions never authorize new requests, expanded scopes or data disclosure.

## Hosted transport integration (candidate)

`createTeamGridMcpHttpHandler(options)` provides a fetch-compatible regional
HTTP boundary. Its required dependencies are `verifyAccessToken`,
`createDelegatedClient`, `admitRequest`, and an `enabled` kill switch. Configure
exact HTTPS resource/issuer URLs, region and cell. The `work` profile additionally
requires `writesEnabled()`; otherwise it serves its context reads.

The verifier must check the current OAuth grant and return an active authorization
or null for an invalid/revoked token. Provider failures throw and produce 503,
so an outage does not falsely prompt the user to reconnect. Audience, issuer,
expiry, region and cell are checked again at the transport boundary. The delegated
API client is created from the verified grant; it never receives the incoming MCP
bearer token. Its workspace is checked before serving tools. Every HTTP request
gets a fresh authorization and client; no mutable client is shared between users.

Resource metadata and 401/403 scope challenges are included. Scope requirements
are generated from the API capability contract, including compound recurrence
scopes and the mutation workspace check. Native API credentials are rejected at
this endpoint. Requests are bounded to 256 KiB, token query parameters are rejected,
and host/origin validation plus explicit CORS rules are applied.

This library boundary does **not** implement a TeamGrid OAuth authorization
server. Browser consent, PKCE code exchange, refresh rotation, revocation, CIMD
registration, regional persistence and the concrete API delegation adapter must
be implemented and qualified before mounting a public endpoint. Do not implement
the hooks by accepting arbitrary tokens or returning one shared administrator
client. No production URL or hosted-client compatibility is claimed by these tests.

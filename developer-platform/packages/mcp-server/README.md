# @teamgrid/mcp-server

TeamGrid MCP adapter with read-only defaults and explicit domain write profiles.
Every operation uses the shared API client and current server-side permissions.

**Development candidate:** `context`, `work`, `full`, domain profiles and protocol 2026-07-28 support
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
| `full` | 208 | 84 reads and 124 writes across all reviewed business domains |
| `tasks-write` | 39 | Tasks, subtasks, bulk updates and recurrence lifecycle |
| `projects-write` | 20 | Projects, sharing, lifecycle and templates |
| `schedule-write` | 18 | Appointments, absences, availability and planned work |
| `time-write` | 9 | Time entries and timers |
| `content-write` | 18 | Comments, documents, call notes and file metadata |
| `crm-write` | 16 | Contacts and contact groups |
| `catalog-write` | 39 | Lists, tags, services, products and custom fields |
| `finance-write` | 9 | Project statements and time-entry billing |
| `admin-write` | 25 | Workspace settings, members, roles, groups and invitations |
| `automation-write` | 12 | Automation definitions, versions, runs and export jobs |
| `integrations-write` | 10 | Webhooks, delivery inspection/tests and installation metadata |

Each domain includes `teamgrid_workspace_get`. Prefer a domain profile for a focused
workflow; `full` is the complete reviewed inventory. The generated
[coverage table](COVERAGE.md) lists every tool, its concurrency contract and every
excluded API operation. CI rejects drift between the API policy, schemas, SDK
bindings, scopes, installed discovery and that table.

Updating an existing installation cannot enable writes. Select a write profile
explicitly and obtain its required API scopes. Profile selection grants no
permissions: membership, resource sharing, workspace locks, cell ownership and
scopes are still checked by the API for every request.

`--allow-tool` narrows a profile to named tools; `--deny-tool` removes tools.
Repeat either option or use comma-separated names. Unknown tools, overlapping
filters and attempts to enable tools outside the selected profile fail startup.
`TEAMGRID_MCP_ALLOW_TOOLS` and `TEAMGRID_MCP_DENY_TOOLS` provide the same controls.

## Check the setup before starting a host

These candidate commands print a human-facing JSON report and exit; they do not
start the stdio server or register authentication diagnostics as MCP tools.

```sh
teamgrid-mcp --explain-scopes --tool-profile content-write
teamgrid-mcp --check --profile default --tool-profile content-write
```

`--explain-scopes` does not access credentials or contact TeamGrid. It respects
the same profile and allow/deny filters as the server, lists exact required
scopes, identifies write tools and marks sensitive scopes that require an additional
passkey confirmation. The candidate browser flow supports these scopes when its
cell gates and passkey confirmation are qualified. Published 1.2.1 still requires
a narrowly scoped manual credential for sensitive scopes. The report never
silently removes tools or permissions.

`--check` reads the current server credential context and verifies Workspace
access. Missing scopes produce a nonzero exit code and list the affected tools.
It never uses cached profile scopes as proof and never prints a credential or
its full context. A successful check still leaves each operation subject to
current resource, role, sharing and Workspace restrictions. Use the diagnostic
flags in a terminal, not in the MCP host's server arguments.

## Guarded changes

These write profiles are development candidates, not release-qualified. The MCP
client opts into `X-TeamGrid-Resource-CAS: required-v1`. Before core task/project/
template mutations it requires API acknowledgement; the matching App rejects
strict requests while CAS writes, backfill, enforcement or cutover are closed.
Older SDK consumers keep their previous compatibility behavior. The header is a
protocol acknowledgement, not proof of completed cell qualification. The Staging
read fix does not activate CAS or qualify writes. Concurrent writers, stale
revisions and internal service writes still need live qualification per cell.

In `full` and domain profiles, every mutation takes `workspaceId`; bodies use
`data`, and target IDs remain explicit. Conditional writes require the exact
quoted `meta.etag` from a reviewed read. Future occurrence creation accepts
`createIfMissing: true` instead, never both preconditions. Bulk tasks require a
reviewed revision per item and report independent success/conflict/failure.
Creates with an API replay contract require a stable `idempotencyKey`.

Some existing API actions, including ordinary time updates, timers and several
catalog/admin changes, have no revision or replay contract. Their descriptions
and the coverage table say so. They do not claim lost-update protection or retry
an uncertain write automatically. Inspect the target after a timeout before
making another decision. A 202 response is acceptance: inspect the returned
operation until it reaches a terminal state. A missing response never becomes a
fabricated success.

The smaller `work` profile retains its original seven tools and input format:

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
objects, read the object and review the intended change. Supply the exact quoted
`meta.etag` returned by the preceding read. Context/work/domain/full share this
revision contract. A conflict is
returned to the host; the adapter never fetches a newer revision to retry an
old intent. `assigneeIds` replaces the complete assignment set.

Create a stable key for each creation intent. Reuse the same key and payload
on repeated tool calls after a timeout. A timeout does not prove failure.
Comments may notify participants. The API checks every field against current
roles and scopes; sharing and lifecycle changes use their dedicated tools.

## Context and output safety

New context tools use the matching comments:read, documents:read, files:read,
appointments:read, availability:read or custom-field-values:read scope. Calendar
and availability reads require an increasing window of at most 31 days and
explicit timezone offsets. File tools return metadata, never signed transfers.

All tools have bounded strict inputs, response-envelope output schemas and accurate
read/write, destructive and idempotency annotations. API errors retain bounded
machine codes, HTTP status, request ID and retry delay. Unexpected errors use
a fixed message. No bearer credentials, transport headers, webhook signing secrets or raw causes are
projected. Context/work/domain/full responses copy only a valid strong ETag into
`meta.etag`. Results are limited to 256 KiB.

`teamgrid_document_get` returns at most 16,384 UTF-16 units of content. Follow
`meta.contentPage.nextOffset` with the same `expectedRevision` until it is null.
A changed revision aborts continuation; restart the read. Document mutations
return metadata, `meta.outcome=completed` and the new ETag without repeating
content. Document inputs support the API content limit inside an 8 MiB JSON
bound; other tool inputs remain bounded to 256 KiB.

A 30-second operation budget and cancellation propagate through SDK calls,
including response bodies. Request IDs are generated per MCP operation and
retained across its API calls. An upstream Retry-After is never shortened;
when it exceeds the remaining budget the error retains that delay. A timed-out
or cancelled mutation may already have committed: inspect the target or retained
operation ID before deciding whether to repeat it.

Product purchase prices and time-entry billing fields remain removed from the
legacy read profiles. Domain/full tools use the API's scope-filtered business
projection. Optional financial fields still require their separate finance
scopes; base scope diagnostics do not promise access to these fields. Current
roles, direct membership, resource sharing and workspace locks remain decisive.

Thirty API operations are intentionally outside MCP: credential issuance and
rotation, authentication/disconnection diagnostics, signed file/export transfer
intents and binary transfers, webhook secret creation/rotation, capability
negotiation and the high-volume change feed. File rename/archive/restore,
metadata and document content are supported. Uploading local bytes remains an
explicit CLI/SDK transfer. No tool accepts arbitrary URLs, headers or raw HTTP
commands to bypass this boundary. Invitations, comments, webhook tests and
planned automation can affect other people; hosts must use the user's actual
authorization, not a model-supplied confirmation flag.

Treat every task, comment and document as untrusted customer data. Embedded
instructions never authorize new requests, expanded scopes or data disclosure.

## Hosted transport integration (candidate)

`createTeamGridMcpHttpHandler(options)` provides a fetch-compatible regional
HTTP boundary. Its required dependencies are `verifyAccessToken`,
`createDelegatedClient`, `admitRequest`, and an `enabled` kill switch. Configure
exact HTTPS resource/issuer URLs, region and cell. Every write profile additionally
requires `writesEnabled()`; otherwise all mutation tools are removed while reads
remain. Delegated clients must opt into `requireResourceCas: true` as well.

The verifier must check the current OAuth grant and return an active authorization
or null for an invalid/revoked token. Provider failures throw and produce 503,
so an outage does not falsely prompt the user to reconnect. Audience, issuer,
expiry, region and cell are checked again at the transport boundary. The delegated
API client is created from the verified grant; it never receives the incoming MCP
bearer token. Its workspace is checked before serving tools. Every HTTP request
gets a fresh authorization and client; no mutable client is shared between users.

Resource metadata and 401/403 scope challenges are included. Initial consent
requests only `workspace:read`; advertised scopes follow the active profile and
write gate. Known field-dependent finance and target-read scopes produce an
action-specific challenge. Business permission failures never trigger consent.
Scope requirements
are generated from the API capability contract, including compound recurrence
scopes and the mutation workspace check. Native API credentials are rejected at
this endpoint. Requests are bounded to 8 MiB with smaller per-tool limits, token query parameters are rejected,
and host/origin validation plus explicit CORS rules are applied.

This library boundary does **not** implement a TeamGrid OAuth authorization
server. Browser consent, PKCE code exchange, refresh rotation, revocation, CIMD
registration, regional persistence and the concrete API delegation adapter must
be implemented and qualified before mounting a public endpoint. Do not implement
the hooks by accepting arbitrary tokens or returning one shared administrator
client. No production URL or hosted-client compatibility is claimed by these tests.


## Hosted runtime and private resources (candidate)

The `teamgrid-mcp-http` entry point and immutable container integrate the regional
OAuth provider, request admission, distinct API delegation, bounded requests,
readiness and safe request correlation. See the
[hosted runtime contract](../../hosting/README.md) for exact configuration and
release requirements. No public hosted endpoint is released yet.

File/export lookups return a `meta.privateResource` URI when that profile exposes
the corresponding tool. `resources/read` reauthorizes and delivers at most 1 MiB;
private transfer URLs stay internal. Larger downloads use an independently
authorized App or CLI transfer flow. A separate login cannot access exports
owned by another OAuth grant. Uploads use the existing App/CLI/SDK transfer path.

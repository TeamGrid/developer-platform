# @teamgrid/mcp-server

TeamGrid MCP adapter with read-only defaults and explicit domain write profiles.
Every operation uses the shared API client and current server-side permissions.

Version 1.2.2 includes `context`, `work`, `full`, domain profiles and protocol
2026-07-28 support. Earlier 1.2.1 installations retain their original tool set.

## Authentication and transport

Use `teamgrid auth login` to select a Workspace and approve its scopes in the
browser, then `teamgrid auth status --check`. Sensitive scopes require Passkey
confirmation. `--manual` imports a narrowly scoped credential from Developer
settings. The adapter reads
the same macOS Keychain, Linux Secret Service, or Windows Credential Manager
profile as the CLI. The MCP process does not open a browser.

`TEAMGRID_API_TOKEN` and an approved `TEAMGRID_API_BASE_URL` override are
available for ephemeral CI processes. Never put credentials in arguments or
share the profile's keychain contents.

The stdio entry point serves protocol 2026-07-28 and legacy 2025 clients
from the same registry. Packed-install CI tests both eras against the actual
installed binary. Hosted OAuth uses `https://mcp-de.teamgrid.app/mcp` in DE and
`https://mcp-us.teamgrid.app/mcp` in US. A connection selects one Workspace and
remains subject to its current permissions.

Hosted presentation is selected only from the freshly verified OAuth client ID.
ChatGPT receives tool-result consent metadata; other clients receive HTTP 403
scope challenges, including rights first determined by the API. Every consent
challenge preserves previously approved scopes. For Claude, all modifying tools
advertise `destructiveHint: true` so its confirmation policy covers creations too.
This changes metadata, not the underlying authorization or mutation semantics.

Static Microsoft/Claude registrations can be mapped through the operator-only
`TEAMGRID_MCP_HOST_CLIENTS` JSON array, for example
`[{"clientId":"your-registered-client-id","host":"microsoft365"}]`.
Supported profiles are `standard`, `openai`, `anthropic` and `microsoft365`.
Callback URLs, user agents and request parameters cannot select a host profile.
The proposed public packages and their outstanding qualification are documented
in [AI integrations](../../../integrations/README.md).

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

These commands print a human-facing JSON report and exit; they do not
start the stdio server or register authentication diagnostics as MCP tools.

```sh
teamgrid-mcp --explain-scopes --tool-profile content-write
teamgrid-mcp --check --profile default --tool-profile content-write
```

`--explain-scopes` does not access credentials or contact TeamGrid. It respects
the same profile and allow/deny filters as the server, lists exact required
scopes, identifies write tools and marks sensitive scopes that require an additional
passkey confirmation. The browser flow supports these scopes with personal Passkey confirmation.
Published 1.2.1 still requires
a narrowly scoped manual credential for sensitive scopes. The report never
silently removes tools or permissions.

`--check` reads the current server credential context and verifies Workspace
access. Missing scopes produce a nonzero exit code and list the affected tools.
It never uses cached profile scopes as proof and never prints a credential or
its full context. A successful check still leaves each operation subject to
current resource, role, sharing and Workspace restrictions. Use the diagnostic
flags in a terminal, not in the MCP host's server arguments.

## Guarded changes

Version 1.2.2 includes these write profiles. The MCP
client opts into `X-TeamGrid-Resource-CAS: required-v1`. Before core task/project/
template mutations it requires API acknowledgement; the matching App rejects
strict requests while CAS writes, backfill, enforcement or cutover are closed.
Older SDK consumers keep their previous compatibility behavior. The header is a
protocol acknowledgement, not proof of completed cell qualification. Production
DE and US have the required CAS gates enforced. The accepted release retains
genuine Staging conflict evidence; additional regional functional exercises were
waived by the release owner and are not claimed as passing tests.

In `full` and domain profiles, every mutation takes `workspaceId`; bodies use
`data`, and target IDs remain explicit. Conditional writes require the exact
quoted `meta.etag` from a reviewed read. Future occurrence creation accepts
`createIfMissing: true` instead, never both preconditions. Bulk tasks require a
reviewed revision per item and report independent success/conflict/failure.
Creates with an API replay contract require a stable `idempotencyKey`.

Contact and ordinary time-entry edits now require a reviewed snapshot ETag in MCP.
The SDK opts in with `requireResourceCas`; a compatible API acknowledges
`X-TeamGrid-Snapshot-CAS: required-v1`. The App compares the complete source
snapshot atomically, including intervening Web/legacy edits and time-entry locks.
No customer-document backfill is needed. Legacy API callers retain their existing
behavior unless they opt in or supply `If-Match`. Mixed deployments fail closed
before an unprotected MCP mutation. This additional contract is a candidate change
and must be released with the matching App/API implementation.

Some existing API actions, including timers and several
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

Oversized valid mutation responses return `data.type=mutationReceipt` with the
operation, resource IDs/statuses and the original `meta.outcome`, ETag and
continuation where available. The original API response is schema-validated
before compaction. Accepted or partial actions retain that outcome; a lost or
invalid response never becomes a success receipt. Read omitted attributes by ID.

`teamgrid_contact_get` chunks notes with `notesLimit` (at most 16,384 UTF-16 units),
`notesOffset=meta.notesPage.nextOffset` and the same `expectedRevision=meta.etag`.
Continuation rejects a changed contact. Contact lists omit notes and name the
read tool in metadata. Never replace notes from an incomplete read.

`teamgrid_document_get` returns at most 16,384 UTF-16 units of content. Follow
`meta.contentPage.nextOffset` with the same `expectedRevision` until it is null.
A changed revision aborts continuation; restart the read. Document mutations
return metadata, `meta.outcome=completed` and the new ETag without repeating
content. Document inputs support the API content limit inside an 8 MiB JSON
bound; other tool inputs remain bounded to 256 KiB.

A 30-second operation budget and cancellation propagate through SDK calls,
including response bodies. The hosted gateway emits `teamgrid.mcp.tool` alongside
HTTP request events, using the same request ID across gateway and API calls.
Finite tool/outcome, authorization-challenge, duration, region and cell fields
distinguish tool errors from HTTP 200 delivery. Arguments, customer content,
resource IDs and credentials are excluded; telemetry failure cannot affect delivery.
Request IDs are generated per MCP operation and
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

## Hosted transport integration

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
requests only `workspace:read`. Every advertised tool declares its required
OAuth scopes in `securitySchemes` and the `_meta.securitySchemes` compatibility
mirror; tool visibility never grants those scopes. The catalog follows the active
profile and write gate. Known field-dependent finance and target-read scopes produce an
action-specific challenge. Business permission failures never trigger consent.
For the verified ChatGPT CIMD client, missing tool scopes return an unsuccessful
MCP tool result with `_meta["mcp/www_authenticate"]`, an `insufficient_scope`
challenge and a clear request for additional approval. This uses ChatGPT's
documented tool-level OAuth flow instead of presenting missing permissions as
an expired connection. Other clients retain standard HTTP403 scope challenges.
Invalid or revoked tokens still return HTTP401 for every client; provider
outages remain HTTP503. A denied tool performs no mutation.

The client requests the scopes. The TeamGrid consent screen displays the
requested set for the chosen workspace and currently offers approval or denial
of that set, rather than individual scope checkboxes. Refreshing a token never
adds permissions. A later operation needs a new explicit consent when its scopes
are missing, and sensitive permissions still require personal Passkey confirmation.
Scope requirements
are generated from the API capability contract, including compound recurrence
scopes and the mutation workspace check. Native API credentials are rejected at
this endpoint. Requests are bounded to 8 MiB with smaller per-tool limits, token query parameters are rejected,
and host/origin validation plus explicit CORS rules are applied.

The HTTP handler is the transport library. The TeamGrid hosted runtime supplies
browser consent, PKCE code exchange, refresh rotation, revocation, CIMD
registration, regional persistence and the concrete API delegation adapter.
Custom integrations must provide those dependencies and current authorization;
accepting arbitrary tokens or sharing an administrator client is invalid.


## Hosted runtime and private resources

The `teamgrid-mcp-http` entry point and immutable container integrate the regional
OAuth provider, request admission, distinct API delegation, bounded requests,
readiness and safe request correlation. See the
[hosted runtime contract](../../hosting/README.md) for exact configuration and
release requirements. Production activation is recorded through the guarded
cell release and the release owner's explicit acceptance. Existing actual Stage
checks remain recorded; additional regional exercises were waived for this release.

File/export lookups return a `meta.privateResource` URI when that profile exposes
the corresponding tool. `resources/read` reauthorizes and delivers at most 1 MiB;
private transfer URLs stay internal. Larger downloads use an independently
authorized App or CLI transfer flow. A separate login cannot access exports
owned by another OAuth grant. Uploads use the existing App/CLI/SDK transfer path.


Hosted OAuth starts with workspace, project, task and time-entry read scopes.
Protected Resource Metadata advertises the canonical supported scope catalog;
that is distinct from the initial consent request. Each tool publishes its base
OAuth policy in both descriptor locations, while argument-dependent rights are
requested only for the specific action. The stable and callback-specific verified
ChatGPT client IDs receive the native error-tool-result challenge. A foreign
workspace or a policy-blocked valid grant does not request another login.

The authorization UI can offer narrower read-only or daily-work grants even when
OpenAI initially requests scopes from the full catalog. Only the owner's selected
scopes enter the token; refresh cannot enlarge them. Native authorization and
automatic action resumption are client behavior and need an actual OpenAI QA
flow, beyond the protocol fixture tests. Reuse the exact workspace, payload and
idempotency key if resuming after consent.

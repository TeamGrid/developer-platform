# TeamGrid Developer Platform packages

This workspace contains the public client surfaces for TeamGrid API v1. All
three packages consume the checked OpenAPI contract in `../openapi/v1.json`;
none imports Meteor runtime code.

## Packages

- `@teamgrid/api-client`: typed, cell-aware TypeScript client with timeouts,
  safe retries, idempotent creates, cursor iterators, and stable errors.
- `@teamgrid/cli`: `teamgrid` command for profiles, typed project, contact,
  task, time-entry, list, service, and tag workflows, signed webhook
  management, JSON/JSONL, and automation-safe exits.
- `@teamgrid/mcp-server`: optional local stdio MCP adapter. It exposes only
  bounded read tools and delegates every request to the same API client.

All three packages support Node.js 22.14 through Node.js 24 on Linux, macOS,
and Windows. CI qualifies both Node boundaries on all three operating systems.
Persistent CLI profiles use macOS Keychain, Linux Secret Service, or the native
Windows Credential Manager.

The stable 1.1.0 release is prepared for npm through the default `latest`
channel:

```sh
npm install @teamgrid/api-client@1.1.0
npm install --global @teamgrid/cli@1.1.0
npm install --global @teamgrid/mcp-server@1.1.0
```

Use the exact version shown above in reproducible deployments. Unpinned
installations resolve through `latest`; future preview releases remain isolated
on the explicit `next` channel.

## Credential and routing model

`teamgrid auth login` opens TeamGrid in the system browser. After normal
TeamGrid sign-in, select one workspace, compare the pairing phrase shown in the
browser and terminal, and approve the requested scopes. The owning regional
cell issues a scoped personal credential directly to the CLI through an
Authorization Code + PKCE loopback flow.

The CLI stores the reveal-once credential in macOS Keychain, Linux Secret
Service, or Windows Credential Manager. Its profile file contains only
non-secret region, cell, credential ID, origin, scopes, expiry, optional base
URL, and timestamps. Passwords, browser sessions, authorization codes, and API
tokens are never written to the profile.

Use `teamgrid auth login --no-browser` when the CLI cannot open the browser
automatically but the terminal can still receive a loopback callback. The
printed URL is short lived but contains authentication request material; do
not share it or place it in logs. `--manual` and `--token-stdin` retain the
reveal-once token workflow as an explicit compatibility path.

Browser login currently rejects sensitive scopes because the regional approval
flow does not yet receive a qualified recent-authentication signal. Create a
narrowly scoped personal credential in Developer settings and use `--manual`
for those cases. Device authorization is not part of this release.

Existing profiles require explicit `--replace`; this prevents accidental
orphaning of the previous server credential. Plain `auth logout` remains an
offline-capable local cleanup. `auth logout --revoke` first revokes the exact
selected credential in TeamGrid and removes local state only after the server
confirms permanent revocation. It refuses an ambiguous environment-token
override instead of risking revocation of the wrong credential.

For CI/CD, containers, and unattended services, provide a service-account
credential through `TEAMGRID_API_TOKEN` and a secret manager. The token is not
written to disk, and routing defaults to the credential's signed cell hint.
Set `TEAMGRID_API_BASE_URL` only for an approved local or staging override.

Credential creation is available to authorized administrators in entitled,
unlocked workspaces while cell-local issuance is enabled. A rollout pause
stops creation but keeps existing credentials revocable.

The credential prefix carries an untrusted region/cell routing hint. The client
derives `https://api.<region>.teamgrid.app/v1`; the target cell still verifies
the full credential, workspace, location, expiry, revocation, lock state,
audience, and scopes. `--base-url` and `TEAMGRID_API_BASE_URL` are intended for
local/staging tests; plain HTTP is accepted only on loopback.

## CLI

```sh
teamgrid auth login
teamgrid auth login --preset daily-work
teamgrid auth login --manual
teamgrid auth status --check
teamgrid auth logout --revoke
teamgrid doctor
teamgrid --output json doctor
teamgrid projects list --all --output json
teamgrid tasks create \
  --data '{"name":"Prepare launch","projectId":"project-id"}' \
  --idempotency-key launch-task-1 \
  --output json
teamgrid time-entries list --from 2026-07-01 --to 2026-07-31 --output jsonl
teamgrid time-entries billing get time-entry-id --output json
teamgrid time-entries billing update time-entry-id --billed --if-match "$REVISION"
teamgrid lists create \
  --data '{"name":"Delivery","type":"tasks","parentId":"project-id"}' \
  --idempotency-key delivery-list-1 \
  --output json
teamgrid services update service-id --data '{"billingRate":175}' --output json
teamgrid tags archive tag-id --yes --output json
teamgrid webhooks create \
  --data '{"url":"https://hooks.example.com/teamgrid","actions":["task_created"]}' \
  --idempotency-key webhook-1 \
  --output json
teamgrid webhooks test webhook-id \
  --idempotency-key webhook-test-1 \
  --output json
teamgrid custom-field-values get project project-id field-id --output json
teamgrid project-templates list --origin-project-id project-id --output json
teamgrid tasks update task-id --data '{"name":"Reviewed"}'
teamgrid projects complete project-id \
  --idempotency-key complete-project-id-v1 --wait --output json
teamgrid planned-work list --start 2026-07-20T00:00:00Z --end 2026-07-27T00:00:00Z \
  --user-id user-id --output json
teamgrid changes checkpoint --resource-type task --output json
teamgrid changes list --cursor "$CHECKPOINT" --resource-type task --all --output jsonl
teamgrid task-recurrences create --data @recurrence.json \
  --idempotency-key daily-review-v1 --output json
teamgrid task-recurrences preview-stored recurrence-id --count 10 --output json
teamgrid task-recurrences occurrences list recurrence-id --output json
```

Use `--data @payload.json` or `--data -` for files/stdin. Destructive commands
require confirmation on a terminal and `--yes` in non-interactive jobs.
`TEAMGRID_API_TOKEN` overrides the profile keychain only for the current
process. Secrets are never accepted as command arguments.

Stable exit codes are: `0` success/cancel, `2` local usage/configuration,
`3` authentication, `4` authorization/scope, `5` not found, `6` conflict,
`7` rate limit, and `1` unexpected/server/network failure.

`teamgrid doctor` performs only read operations. It checks local configuration,
credential metadata, the resolved regional base URL, API reachability, client
compatibility, and authenticated capability discovery. Its human or JSON report
never contains the credential or raw authorization data and uses the same stable
exit-code categories.

## TypeScript client

```ts
import { TeamGridClient } from '@teamgrid/api-client'

const client = new TeamGridClient({ token: process.env.TEAMGRID_API_TOKEN! })

for await (const page of client.tasks.pages({ projectId: 'project-id' })) {
  for (const task of page.data) console.log(task.id, task.attributes.name)
}
```

The stable metadata-only change feed is exposed through the API, SDK, and CLI for durable
reconciliation. Its opaque checkpoints are bound to one credential, workspace, cell, epoch, and
exact filter set. The MCP adapter intentionally does not expose this high-volume synchronization
primitive. Use signed webhooks for low-latency notifications and the change feed to detect and
reconcile missed changes.

Recurring tasks use immutable definition versions, a durable occurrence ledger, strong
compare-and-set revisions, and encrypted asynchronous preview/recovery operations. API v1, the TypeScript SDK, and
the CLI expose the complete lifecycle, including preview, pause/resume/end/archive/restore,
ownership transfer, version restore, occurrence overrides/retries, external event ingress, and
recheck operation polling. The MCP adapter exposes only seven bounded saved-definition,
version, preview, and occurrence reads; it never exposes drafts, writes, trigger ingress, or
operation control.

GET requests and POST requests with an idempotency key are retried for bounded transient failures.
Tasks, projects, and project templates expose developer revisions and strong ETags. Every update,
archive, restore, completion, reopen, lifecycle start, and template instantiation requires the
latest revision through `If-Match`, preventing silent overwrites. Other PUT, PATCH, and DELETE
requests are not automatically retried. Errors do not retain or print the bearer credential.
Time-entry billed state has its own finance-sensitive scope and strong revision; it is available
through API, SDK, and CLI, but intentionally absent from every read-only MCP profile.

## Webhook v2 signatures

API v1 webhook creation returns `attributes.signingSecret`. Store it once. v2
deliveries include:

- `X-TeamGrid-Webhook-Id`: stable delivery id for deduplication;
- `X-TeamGrid-Webhook-Timestamp`: Unix seconds;
- `X-TeamGrid-Webhook-Signature`: `v1=<hex HMAC-SHA256>`;
- `X-TeamGrid-Webhook-Version`: `2`.

Verify the signature over `<timestamp>.<exact raw request body>` using the
returned signing secret, compare in constant time, reject stale timestamps,
then deduplicate the delivery id. Do not parse/re-serialize the body before
verification. Legacy UI-created hooks remain version 1 during migration and do
not receive these signature headers.

Authorized workspace administrators can also create signed v2 webhooks in
TeamGrid Settings. The Settings UI presents signed v2 and legacy unsigned v1
hooks separately and reveals a new v2 signing secret only once.

## Optional MCP adapter

MCP is intentionally downstream of API v1 and is not required for automation.
It reads the same CLI keychain profile and offers only bounded read tools.
The default `core` tool profile includes workspace, projects, tasks, recurring-task definitions,
versions and occurrences, time entries, lists, and tags. `collaboration` additionally exposes contacts and
users; `governance` adds webhooks, services, and custom-field definitions. Service reads are kept
out of `core` because they include billing-rate data. `all` is the explicit
union of the collaboration and governance profiles.

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

No remote MCP endpoint, MCP-specific credential, session affinity, write tool, or change-feed tool
is introduced. Custom-field values, project templates, planned work, and their operation-status
resources remain explicitly forbidden from every MCP profile.

## Development gates

```sh
npm ci
npm run verify
```

`verify` regenerates OpenAPI types, type-checks, lints/formats, runs SDK/CLI/MCP
tests (including an in-memory MCP negotiation), and builds all publishable
packages.

### Production conformance

Production conformance is deliberately separate from CI and from the staging mutation smoke. Start
with the offline plan:

```sh
npm run conformance:plan
```

The plan reads the immutable contract set and produces a deterministic inventory of all 87 V0 and
236 V1 operations. It joins V1 with every SDK method or explicit SDK exclusion, CLI command, MCP exposure decision, scope,
execution binding, CAS precondition, and idempotency requirement. V0 compatibility statuses and the
V0-to-V1 migration map remain explicit, so a documented unavailable route is not confused with an
unexpected regression. Planning never loads a credential or contacts TeamGrid.

The read-only phase performs only parameter-free GET requests, uses `limit=1` where supported, runs
sequentially below the shared pre-auth limit, and retries at most two `429` responses. Operations
that need an id, required filter, body, or mutation are recorded as blocked rather than guessed. A
V1 run additionally proves all 235 SDK methods, all 236 CLI operation mappings, the exact 36-tool MCP allowlist, and one
live workspace request through SDK, CLI, and MCP:

```sh
TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION=true \
TEAMGRID_CONFORMANCE_EVIDENCE_PATH=../conformance-evidence/read-only.json \
TEAMGRID_CONFORMANCE_REGION=de \
TEAMGRID_CONFORMANCE_V0_BASE_URL=https://api.teamgrid.app \
TEAMGRID_CONFORMANCE_V0_PROFILE=conformance-v0 \
TEAMGRID_CONFORMANCE_V1_BASE_URL=https://api.de.teamgrid.app/v1 \
TEAMGRID_CONFORMANCE_V1_PROFILE=default \
npm run conformance:read-only
```

Profiles refer to the OS credential store used by the CLI; their secret values are never written to
the profile file, command line, stdout, or evidence. Process-scoped
`TEAMGRID_CONFORMANCE_V0_TOKEN` and `TEAMGRID_CONFORMANCE_V1_TOKEN` remain available for ephemeral
CI environments. `TEAMGRID_CONFORMANCE_VERSIONS=v0` or `v1` can intentionally isolate one contract;
the omitted contract is then recorded as not run.

Store a dedicated conformance credential through the hidden interactive prompt when no CLI profile
secret exists. The token is validated before it is handed directly to macOS Keychain or Linux
Secret Service:

```sh
npm run conformance:credential -- store --version v0 --profile conformance-v0
npm run conformance:credential -- store --version v1 --profile default
npm run conformance:credential -- status --version v1 --profile default
```

Live mode accepts only the canonical HTTPS production endpoints, requires an explicit production
unlock and evidence path, rejects reused V0/V1 credentials, limits timeouts and pacing, and writes
redacted evidence atomically with mode `0600`. It stores status, latency, request id, and fixed error
classifications, never response bodies, exception stacks, URLs with query values, or bearer tokens.

The safe mutation smoke extends that live coverage to resource-addressed mutation routes without
supplying a request body or a real resource identifier. Create, bulk, and workspace-wide mutations
remain blocked: the runner never assumes that missing-body validation will protect production data.
A probed mutation must be rejected with a bounded client, permission, missing-resource, conflict, or
precondition status; any `2xx`, authentication failure, persistent rate limit, or server error fails
the run. It writes a unique mode-`0600` recovery journal before the first request and deliberately
leaves it unfinished if an unexpected mutation succeeds:

```sh
TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION=true \
TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS=true \
TEAMGRID_CONFORMANCE_EVIDENCE_PATH=../conformance-evidence/safe-mutation-smoke.json \
TEAMGRID_CONFORMANCE_CLEANUP_JOURNAL_PATH=../conformance-evidence/safe-mutation-cleanup.json \
TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE=codex-conformance-acme-01 \
TEAMGRID_CONFORMANCE_REGION=de \
TEAMGRID_CONFORMANCE_V0_BASE_URL=https://api.teamgrid.app \
TEAMGRID_CONFORMANCE_V0_PROFILE=conformance-v0 \
TEAMGRID_CONFORMANCE_V1_BASE_URL=https://api.de.teamgrid.app/v1 \
TEAMGRID_CONFORMANCE_V1_PROFILE=default \
npm run conformance:safe-mutation-smoke
```

This proves routing, authentication, validation, safety, and every SDK/CLI/MCP binding that can be
exercised without a fixture. Blocked operations remain explicit; the result cannot be mistaken for
positive write certification.

Positive mutation certification is available only for API v1 and only with a complete external
recipe manifest bound to the exact inventory digest and an explicit `codex-conformance-*`
namespace. Preflight rejects partial coverage, undocumented expected statuses, missing write
preconditions, unknown cleanup operations, or mutations without an explicit cleanup decision
before the first request is sent. Each idempotent creation whose identifier is returned by the API
is journaled before transport; an ambiguous response can therefore be replayed safely to discover
and clean the created resource. Cleanup runs in reverse dependency order and incomplete cleanup
cannot produce passing evidence.

```sh
TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION=true \
TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS=true \
TEAMGRID_CONFORMANCE_VERSIONS=v1 \
TEAMGRID_CONFORMANCE_EVIDENCE_PATH=../conformance-evidence/certification.json \
TEAMGRID_CONFORMANCE_CLEANUP_JOURNAL_PATH=../conformance-evidence/certification-cleanup.json \
TEAMGRID_CONFORMANCE_RECIPE_PATH=../conformance-recipes/acme-v1.json \
TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE=codex-conformance-acme-01 \
TEAMGRID_CONFORMANCE_REGION=de \
TEAMGRID_CONFORMANCE_V1_BASE_URL=https://api.de.teamgrid.app/v1 \
TEAMGRID_CONFORMANCE_V1_PROFILE=default \
npm run conformance:certification
```

If a process or machine fails after an intent was journaled, rerun the same environment with
`npm run conformance:certification:recover`. Recovery refuses a different fixture namespace,
replays only the recorded idempotent intent, and then reconciles the cleanup journal. Use a new,
nonexistent evidence and journal path for every normal certification run; never delete an
unfinished journal to bypass recovery.

Canonical contract updates use `npm run sync:contracts --
/path/to/teamgrid-api <full-api-commit-sha>`. The command reads every artifact
from that immutable Git object, verifies the API-owned manifest, and records
the exact repository, commit, manifest size, and manifest digest in
`../openapi/source.json`. Never copy contract files from an uncommitted API
working tree.

The mirrored manifest also contains `developer-action-policy-registry.json`.
It pins the App/API authorization registry version, SHA-256 identity, all 236
action policies, and 12 principal-policy rollout families. SDK, CLI, and MCP do
not evaluate or broaden this policy locally; every request remains subject to
the owning App cell's authorization decision.

Before publishing, also run `npm audit --omit=dev` and `npm pack --dry-run` in
each package directory, then inspect the file lists. Releases are submitted by
the public repository's stage-only trusted publisher and require an explicit
2FA-backed approval on npm before they become installable. Traditional npm
publish tokens are disabled for all three packages. Published prereleases use
the `next` dist-tag; stable releases use `latest`.

To release, update all three package versions, commit and tag the exact source
as `v<version>`. The same immutable developer-platform commit and contract
manifest must first pass staging, the DE production canary, and the separate US
production promotion in `TeamGrid/teamgrid`. Dispatch `Stage npm release` from
the tag with the matching version, dist-tag, exact API runtime image SHA, and
successful `Promote qualified release to US production` run URL. The workflow
verifies the exact US artifact, its cited DE-canary run and artifact, the
App/API/Developer Platform revisions, and the contract-manifest SHA-256 as one
immutable promotion chain before it can stage packages. The API runtime SHA is
validated independently from the API commit that supplied the mirrored OpenAPI
contract, because a release-hardening commit may legitimately follow the
contract-source commit.
It needs the `TEAMGRID_REPOSITORY_TOKEN` secret in the protected `npm`
environment solely to read that private workflow run and its artifacts.

Inspect the staged artifacts with `npm stage list`, `npm stage view`, and `npm
stage download`, then approve each package with npm's 2FA-backed staged-release
flow. Reject any stage whose contents or provenance do not match the tag. The
workflow accepts prereleases only with `next` and stable versions only with
`latest`; a stable release additionally requires the explicit `confirm_ga`
input after the separately governed GA decision.

After npm approval, dispatch `Verify published npm release` with the exact
version and dist-tag. It waits for all three registry entries to converge,
performs a clean installation, verifies registry signatures, imports each
package, and invokes both public binaries. Treat that workflow as the registry
publication gate rather than assuming that npm approval alone proves a usable
release.

The destructive-safe live proof is available as `npm run e2e:staging`. Local
and exploratory runs are explicitly non-qualifying by leaving
`TEAMGRID_E2E_QUALIFY_RELEASE=false`; their negative fixtures remain optional.
A release workflow must set `TEAMGRID_E2E_QUALIFY_RELEASE=true`. That mode
fails before its first mutation unless the expired credential, foreign task,
read-only credential, and wrong-cell credential are all present. It also
requires the protected direct-origin URL, the expected `de` or `us` region and cell, an evidence output path,
and exact App, API, Developer Platform, producer, contract-manifest, and
workflow-run bindings. The script refuses mutation outside a staging/loopback
base URL unless `TEAMGRID_E2E_ALLOW_NON_STAGING=true` is deliberately set by a
production qualification workflow. With `TEAMGRID_E2E_WEBHOOK_DELIVERY=true`, the default receiver creates a
disposable Webhook.site token, captures synthetic staging data, verifies the
exact raw-body HMAC locally, and deletes the token in cleanup. Set
`TEAMGRID_E2E_WEBHOOK_RECEIVER=quick-tunnel` only for local experiments where a
Cloudflare Quick Tunnel is known to be reachable.

The staging proof also spawns the built CLI for a live workspace request and negotiates with the
built MCP stdio binary before making changes. It then verifies custom-field compare-and-set values,
project-template capture/instantiation, planned-work
replacement, and a bounded asynchronous private export through job completion, download-intent
creation, and SDK-streamed CSV download. Export metadata expires with the job queue and the tiny
test object is removed by the required one-day bucket lifecycle. The script never permits these
mutation smokes against an unmarked production hostname. Release qualification is stricter: cleanup failures fail
the run, every created API resource is re-read until its archived or absent terminal state is proven,
and the machine-readable
evidence is written atomically only after reconciliation. The staging deployment embeds that report
and its SHA-256 in the immutable promotion artifact; DE promotion revalidates its claims, target,
exact refs, digest, and cleanup.

The same staging workflow then runs `npm run e2e:staging:load`. Its fixed
release profile performs 720 authenticated, read-only requests over four
minutes at three requests per second across workspace, capability,
entitlement, project, task, contact, and user reads. This stays
below the shared 300-request-per-minute pre-auth limit while exercising seven
cell-owned query scenarios. Qualification requires zero HTTP, schema, target,
request-ID, timeout, and rate-limit failures; at least 2.5 achieved requests
per second; p95 at most 2 seconds; p99 at most 5 seconds; and no request above
10 seconds. The redacted load report contains no URL or credential and is
hashed and embedded beside the mutation/security report in the v4 deployment
evidence. The load command refuses non-staging hosts unless an explicit local
or controlled override is present.

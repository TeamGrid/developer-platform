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

The current prerelease is available from npm through the explicit `next`
channel:

```sh
npm install @teamgrid/api-client@next
npm install --global @teamgrid/cli@next
npm install --global @teamgrid/mcp-server@next
```

Use an exact version instead of `next` in reproducible deployments. Until the
first stable release exists, npm also exposes the initial package version as
`latest`; prerelease consumers should still select `next` explicitly.

## Credential and routing model

Create a scoped API v1 credential in TeamGrid under Settings → Team →
Developer. A credential is shown once. The CLI stores it in macOS Keychain or
Linux Secret Service; the non-secret profile file contains only region, cell,
credential id, optional base URL, and timestamps.

Credential creation appears only for workspaces in the controlled Developer
Platform beta and while server-side issuance is enabled. Existing credentials
remain revocable during a rollout pause.

The credential prefix carries an untrusted region/cell routing hint. The client
derives `https://api.<region>.teamgrid.app/v1`; the target cell still verifies
the full credential, workspace, location, expiry, revocation, lock state,
audience, and scopes. `--base-url` and `TEAMGRID_API_BASE_URL` are intended for
local/staging tests; plain HTTP is accepted only on loopback.

## CLI

```sh
teamgrid auth login
teamgrid auth status --check
teamgrid projects list --all --output json
teamgrid tasks create \
  --data '{"name":"Prepare launch","projectId":"project-id"}' \
  --idempotency-key launch-task-1 \
  --output json
teamgrid time-entries list --from 2026-07-01 --to 2026-07-31 --output jsonl
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
teamgrid changes checkpoint --resource-type project,task --output json
teamgrid changes list --cursor "$CHECKPOINT" --resource-type project,task --output json
teamgrid custom-field-values get project project-id field-id --output json
teamgrid project-templates list --origin-project-id project-id --output json
teamgrid tasks update task-id --data '{"name":"Reviewed"}' --if-match "$TASK_REVISION"
teamgrid projects complete project-id --if-match "$PROJECT_REVISION" \
  --idempotency-key complete-project-id-v1 --wait --output json
teamgrid planned-work list --start 2026-07-20T00:00:00Z --end 2026-07-27T00:00:00Z \
  --user-id user-id --output json
```

Use `--data @payload.json` or `--data -` for files/stdin. Destructive commands
require confirmation on a terminal and `--yes` in non-interactive jobs.
`TEAMGRID_API_TOKEN` overrides the profile keychain only for the current
process. Secrets are never accepted as command arguments.

Stable exit codes are: `0` success/cancel, `2` local usage/configuration,
`3` authentication, `4` authorization/scope, `5` not found, `6` conflict,
`7` rate limit, and `1` unexpected/server/network failure.

## TypeScript client

```ts
import { TeamGridClient } from '@teamgrid/api-client'

const client = new TeamGridClient({ token: process.env.TEAMGRID_API_TOKEN! })

for await (const page of client.tasks.pages({ projectId: 'project-id' })) {
  for (const task of page.data) console.log(task.id, task.attributes.name)
}
```

For race-free mirrors, call `client.changes.snapshotThenCatchUp()`: it takes a cell-local checkpoint
before running the supplied full-snapshot callback and returns a bounded change-page iterator from
that checkpoint. Change events contain resource identity and operation metadata, not document
payloads. Persist every returned checkpoint only after applying the page. Continue until
`page.meta.page.caughtUp` is true; an empty page alone is not the completion contract.

GET requests, POST requests with an idempotency key, and compare-and-set planned-work PUTs with an
idempotency key are retried for bounded transient failures. Task, project, and project-template
mutations require the latest typed `developerRevision` or strong ETag. Stale `If-Match` requests
fail with HTTP `412`; callers must fetch, reconcile, and retry explicitly. Other PUT, PATCH, and
DELETE requests are not automatically retried. Errors do
not retain or print the bearer credential.

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
TeamGrid Settings during the controlled beta. The Settings UI presents signed
v2 and legacy unsigned v1 hooks separately and reveals a new v2 signing secret
only once.

## Optional MCP adapter

MCP is intentionally downstream of API v1 and is not required for automation.
It reads the same CLI keychain profile and offers only bounded read tools.
The default `core` tool profile includes workspace, projects, tasks, time
entries, lists, and tags. `collaboration` additionally exposes contacts and
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

Canonical contract updates use `npm run sync:contracts --
/path/to/teamgrid-api <full-api-commit-sha>`. The command reads every artifact
from that immutable Git object, verifies the API-owned manifest, and records
the exact repository, commit, manifest size, and manifest digest in
`../openapi/source.json`. Never copy contract files from an uncommitted API
working tree.

The mirrored manifest also contains `developer-action-policy-registry.json`.
It pins the App/API authorization registry version, SHA-256 identity, all 182
action policies, and 12 principal-policy rollout families. SDK, CLI, and MCP do
not evaluate or broaden this policy locally; every request remains subject to
the owning App cell's authorization decision.

Before publishing, also run `npm audit --omit=dev` and `npm pack --dry-run` in
each package directory, then inspect the file lists. Releases are submitted by
the public repository's stage-only trusted publisher and require an explicit
2FA-backed approval on npm before they become installable. Traditional npm
publish tokens are disabled for all three packages. Published prereleases use
the `next` dist-tag; future stable releases use `latest`.

To release, update all three package versions, commit and tag the exact source
as `v<version>`. The same immutable developer-platform commit and contract
manifest must first pass staging, the DE production canary, and the separate US
production promotion in `TeamGrid/teamgrid`. Dispatch `Stage npm release` from
the tag with the matching version, dist-tag, and successful `Promote qualified
release to US production` run URL. The workflow verifies the exact US artifact,
its cited DE-canary run and artifact, the App/API/Developer Platform revisions,
and the contract-manifest SHA-256 as one immutable promotion chain before it can
stage packages.
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
built MCP stdio binary before making changes. It then verifies the fixed-watermark change feed,
custom-field compare-and-set values, project-template capture/instantiation, planned-work
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
entitlement, project, task, contact, user, and change-feed reads. This stays
below the shared 300-request-per-minute pre-auth limit while exercising eight
cell-owned query paths. Qualification requires zero HTTP, schema, target,
request-ID, timeout, and rate-limit failures; at least 2.5 achieved requests
per second; p95 at most 2 seconds; p99 at most 5 seconds; and no request above
10 seconds. The redacted load report contains no URL or credential and is
hashed and embedded beside the mutation/security report in the v4 deployment
evidence. The load command refuses non-staging hosts unless an explicit local
or controlled override is present.

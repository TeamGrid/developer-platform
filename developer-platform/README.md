# TeamGrid Developer Platform packages

This workspace contains the public client surfaces for TeamGrid API v1. All
three packages consume the checked OpenAPI contract in `../openapi/v1.json`;
none imports Meteor runtime code.

## Packages

- `@teamgrid/api-client`: typed, cell-aware TypeScript client with timeouts,
  safe retries, idempotent creates, cursor iterators, and stable errors.
- `@teamgrid/cli`: `teamgrid` command for profiles, reads, task/time-entry
  writes, signed webhook management, JSON/JSONL, and automation-safe exits.
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
teamgrid webhooks create \
  --data '{"url":"https://hooks.example.com/teamgrid","actions":["task_created"]}' \
  --idempotency-key webhook-1 \
  --output json
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

GET requests and POST requests with an idempotency key are retried for bounded
transient failures. PATCH and DELETE are not automatically retried. Errors do
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
It reads the same CLI keychain profile and offers only workspace/project/task/
time/contact/user/webhook/audit reads.

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

No remote MCP endpoint, MCP-specific credential, session affinity, or write
tool is introduced.

## Development gates

```sh
npm ci
npm run verify
```

`verify` regenerates OpenAPI types, type-checks, lints/formats, runs SDK/CLI/MCP
tests (including an in-memory MCP negotiation), and builds all publishable
packages.

Before publishing, also run `npm audit --omit=dev` and `npm pack --dry-run` in
each package directory, then inspect the file lists. Releases are submitted by
the public repository's stage-only trusted publisher and require an explicit
2FA-backed approval on npm before they become installable. Traditional npm
publish tokens are disabled for all three packages. Published prereleases use
the `next` dist-tag; future stable releases use `latest`.

To release, update all three package versions, commit and tag the exact source
as `v<version>`, then dispatch `Stage npm release` from that tag with the
matching version and dist-tag. Inspect the staged artifacts with `npm stage
list`, `npm stage view`, and `npm stage download`, then approve each package
with npm's 2FA-backed staged-release flow. Reject any stage whose contents or
provenance do not match the tag. The workflow accepts prereleases only with
`next` and stable versions only with `latest`.

The destructive-safe staging proof is available as `npm run e2e:staging`. It
refuses mutation outside a staging/loopback base URL unless explicitly
overridden and accepts negative-test credentials through environment variables
only. With `TEAMGRID_E2E_WEBHOOK_DELIVERY=true`, the default receiver creates a
disposable Webhook.site token, captures synthetic staging data, verifies the
exact raw-body HMAC locally, and deletes the token in cleanup. Set
`TEAMGRID_E2E_WEBHOOK_RECEIVER=quick-tunnel` only for local experiments where a
Cloudflare Quick Tunnel is known to be reachable.

# Regional MCP runtime — candidate

This runtime is implemented and locally tested. No hosted public endpoint is
released. Promotion requires the App repository's Release Pipeline v2, the same
App/API/contract bindings, and live OAuth/write qualification in each cell.
A Docker smoke or a passing package build alone does not authorize enablement.

## Build and process

From the repository root, build `developer-platform/hosting/Dockerfile` with
`SOURCE_REVISION` set to the exact Git SHA. CI builds and smoke-tests the image
only after all six package matrix jobs pass. A protected `main` push publishes
`ghcr.io/teamgrid/teamgrid-mcp:<sha>`. Pin the resolved image digest when deploying;
do not use `latest`. The base Node image is also pinned by digest.

The image runs as `node` on port 8080. Run with a read-only root filesystem,
all capabilities dropped and `no-new-privileges`; no persistent token storage
is needed. `smoke-image.sh IMAGE` checks these settings with synthetic credentials
and cleans up its isolated container. The standalone command is `teamgrid-mcp-http`.

## Private runtime configuration

| Variable | Meaning |
| --- | --- |
| `TEAMGRID_MCP_RESOURCE` | Exact public HTTPS resource URL, including its path |
| `TEAMGRID_OAUTH_ISSUER` | Exact owning-cell HTTPS issuer, ending in `/` |
| `TEAMGRID_REGION`, `TEAMGRID_CELL_ID` | Owning regional cell; must match every delegation |
| `TEAMGRID_API_BASE_URL` | Fixed regional HTTPS API URL ending in `/v1` |
| `TEAMGRID_API_ORIGIN_SECRET` | Existing private API-origin authorization; never a user credential |
| `TEAMGRID_MCP_SERVICE_SECRET` | Dedicated 32–256-character App/gateway service secret |
| `TEAMGRID_MCP_ENABLED` | Explicit `true`/`false`; default `false` |
| `TEAMGRID_MCP_WRITES_ENABLED` | Additional write gate; default `false` |
| `TEAMGRID_MCP_TOOL_PROFILE` | Reviewed tool profile; default `core` |
| `TEAMGRID_MCP_ALLOWED_ORIGINS` | Space-separated exact browser origins; no wildcard |
| `TEAMGRID_MCP_LISTEN_HOST`, `PORT` | Bind address/port; image uses `0.0.0.0:8080` |

Use protected secret injection. Never place real values in source, image build
arguments, workflow dispatch inputs, manifests or incident reports. CORS origins
are independent of OAuth callback registration. Originless native requests still
require OAuth; a supplied browser origin must be explicitly allowed.

`/healthz` reports process liveness. `/readyz`, with the canonical resource Host,
checks enabled state and bounded provider discovery (issuer, token endpoint and
S256). It does not prove a successful user login, API write or current CAS gates.
Admission and access verification recheck the provider on requests; provider
outages return 503, revoked grants return an OAuth challenge, and quotas preserve
429/Retry-After. The gateway has bounded bodies/concurrency and graceful shutdown.

Only publish the protected-resource metadata and the configured MCP path through
the edge. Provider `/internal/developer/oauth/*` paths require service authentication
and should also be limited to the gateway network. Preserve canonical Host/TLS,
no-store responses and the exact regional issuer/resource identities. Never send
MCP access tokens directly to the business API: the App issues a distinct short
API delegation tied to the same user, workspace, client, grant and scopes.

Safe logs include request ID, cell, fixed event/endpoint, status and elapsed time.
They exclude raw URLs, bodies, credential values, subjects and transfer URLs.
Use the request ID to join gateway, provider and API diagnostics.

## Content and qualification

Profiles containing file/export lookup expose `teamgrid://files/{id}` and
`teamgrid://exports/{id}` resource templates. Reads reauthorize and deliver at
most 1 MiB of private content, with a 30-second budget. Signed URLs and intent
credentials stay internal. Content is untrusted customer data. For an independently
authorized local profile, `teamgrid files download ID --file PATH` supports up to
50 MiB and creates a new mode-0600 file without overwriting an existing path.
Upload creation/finalization remains in the existing App/CLI/SDK transfer flow;
there is no arbitrary filesystem or URL-fetch MCP tool. Remote export ownership
is grant-specific; a separate local CLI login does not acquire that ownership.

Before enabling a cell, record exact image/package/contract identities and test:
central login and workspace handoff, minimal consent and passkey step-up, refresh
rotation/reuse, disconnect/reconnect, two isolated users/workspaces, fresh role
and membership removal, locked workspace and wrong cell, real file/export delivery,
strict core CAS conflicts, uncertain writes and resume, origin/preflight, load and
provider outage. Keep writes closed until the write qualification is complete.

Revoking one connection invalidates its family and API delegation on subsequent
requests. Disable the MCP gate to stop new remote access. Revert an image only to
a compatible predecessor through the release runbook; never reset existing API,
credential issuance, passkeys or other Production baseline features.

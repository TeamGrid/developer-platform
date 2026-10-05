# Self-hosting on TeamGrid infrastructure

The selected hosting model is TeamGrid's existing infrastructure. The proposed
first global entry runs in the DE cell (`de-nbg-001`, Nuremberg) as a separate
Compose project. DE and US regional Apps remain the grant/permission authorities.
The existing public Caddy 2.8.4 terminates TLS for `mcp.teamgrid.app` and forwards
to two bounded global service replicas through a dedicated ingress network.
The proposed origin is still unprovisioned; these files do not authorize a release.

The global process handles MCP payloads, including responses from the US API.
Self-hosting therefore still includes DE processing/transit for US requests.
Record this actual data flow, locations, retention and legal disclosure before
public activation. A DE gateway is not a promise of exclusively US processing.

## Operating separation

- Application project: `/opt/teamgrid`, unchanged regional services and data.
- Global project: `/opt/teamgrid-federation-production`, two non-root read-only
  replicas, each limited to 512 MiB, 0.75 CPU and 128 processes.
- Dedicated global TLS Mongo replica set and its database/backup lifecycle.
  It is not part of an application-container rollout or rollback.
- Three pre-provisioned external networks: dedicated ingress, dedicated metadata
  DB and outbound egress. Component rollout creates none of these networks.
  Only existing Caddy additionally joins ingress; App/API and regional Mongo
  do not join it. Global replicas do not join `teamgrid_default`.
- No global service or database port is published on the host. Readiness and
  liveness remain available only through the protected operations context.

The read-only host inventory on 2026-10-05 confirmed DE/US Compose/Caddy and
separate Staging. The DE Mongo process is not configured for TLS/authentication;
do not change it incidentally or connect this service to it. Provision a separate
small TLS/authenticated replica set with the collection-scoped role in
[the service contract](README.md#database-and-admission), initialized indexes,
measured storage/cache limits, private CA distribution and tested backup/restore.
Capacity must be measured under actual load before admission; two replicas on
one V-server provide process continuity, not host or replica-set HA.

## Reproducible preparation

Prepare the private `runtime/service.json` and `runtime/clients.json` from the
service contract. Both remain regular owner-only files readable by UID 1000.
The service uses `listen.host=0.0.0.0`, `listen.port=8080` and
`clientPolicyFile=/run/teamgrid-federation/clients.json`. Keep `enabled` and
`writesEnabled` false for initial preparation. A custom database CA can be
mounted in this same private directory and selected through `tlsCAFile` in the
private Mongo URI; no certificate bypass is supported.
Run preparation as the private input files' owner. On the service host, runtime
files and directory must be owned by UID 1000 with modes 0600 and 0700; copies
prepared elsewhere remain private to their operator before installation.

The operator's private deployment JSON has this versioned shape. Replace the
image digest and revision with the same admitted immutable image identities:

```json
{
  "version": 1,
  "project": "teamgrid-federation-production",
  "sourceRevision": "<40-character-admitted-SDK-SHA>",
  "image": "ghcr.io/teamgrid/teamgrid-federated-mcp@sha256:<64-character-image-digest>",
  "runtimeDirectory": "/opt/teamgrid-federation-production/releases/<v2-release-id>/runtime",
  "databaseNetwork": "teamgrid-federation-production-db",
  "browserServiceIps": ["159.195.80.235", "152.53.195.156"]
}
```

Use `teamgrid-federation-staging` and its separate DB/network/private files for
Staging qualification. Real Staging OAuth issuer, callbacks, workspace placement
and browser-source addresses must be qualified separately; do not copy production
credentials or point Staging at production data. Fixtures are not registration
or placement evidence.
The example browser IPs are host inventory addresses, not verified ingress peer
addresses. Measure the actual direct peer separately for DE's same-host Docker
route and US's external route; bridge/NAT addresses may differ. Admit only the
exact verified addresses, never a broad private subnet or forwarded-header claim.

For OpenAI submission, the deployment JSON may additionally contain
`openaiDomainVerificationToken`, taken from this plugin's portal connection dialog.
This public ownership proof is rendered as plain text only for GET/HEAD on the
exact `/.well-known/openai-apps-challenge` path. It grants no API/OAuth access.
Inventory any existing proof before installing it; never overwrite a different
plugin's verification token. The proof remains bound to the admitted deployment
and Caddy file digests. Omission leaves this path unavailable.

```sh
TEAMGRID_FEDERATION_CONFIG_FILE=<absolute-private-service-file> \
TEAMGRID_FEDERATION_DEPLOYMENT_FILE=<absolute-private-deployment-file> \
node developer-platform/hosting/federated/prepare-self-hosted.mjs \
  <absolute-new-output-directory>
```

Preparation creates three private files and never overwrites an existing output
directory: `compose.json`, `Caddyfile.site`, `caddy-network.review.json`. They
contain no Mongo URI or service credentials. JSON is accepted as a Compose
configuration; validate using `docker compose --file <prepared-compose> config`.
Preparation does not start containers, create a network, edit Caddy, provision
registrations or publish DNS. The renderer accepts digest-pinned images only;
check its OCI source/revision/runtime labels and protected-source build evidence
against the admitted release before using it.

The Caddy network file is a **review patch** for the existing persisted base
Compose definition. It adds the ingress network and a read-only persistent site
fragment mount from `/opt/<project>/Caddyfile.site` to `/etc/caddy/<project>.site`.
Import that exact fragment in the governed base Caddyfile. Preserve every existing Caddy mount, port, network and
option. Do not use an untracked one-off network attachment or a transient override
that the next App release would discard. Apply the reviewed addition through
the governed release/configuration path, with recorded before/after digests.

## Exact authority and private ingress

The fixed production provider URLs derive from the existing regional issuers:

| Cell | Private provider |
| --- | --- |
| de-nbg-001 | `https://mcp-de.teamgrid.app/internal/developer/oauth/integrations/ai-global/access` |
| us-mnz-001 | `https://mcp-us.teamgrid.app/internal/developer/oauth/integrations/ai-global/access` |

The private path must reach the owning regional App with that regional issuer
Host. It cannot use the ordinary App hostname or a caller-selected target.
Additional regional configuration binds issuer `https://mcp.teamgrid.app/`,
resource `https://mcp.teamgrid.app/mcp`, integration ID `ai-global` and the
existing `https://login.teamgrid.app/` authorization UI. Preserve the current
regional issuer/resource and every standing feature baseline.

Global config uses the same login origin for selection and `teamgrid.app` for
workspace navigation. Provision the separate regional service credentials, API
origin credentials, browser broker secret and federation receipt recovery key
privately. Match client IDs, callbacks, methods, secret hashes, CIMD policy and
host profiles across the owning regions before activation. No synchronizer is
implemented. The current deployed App does not contain the draft browser/global
changes; source qualification is not a live endpoint qualification.

`Caddyfile.site` exposes only MCP, exact discovery/OAuth paths and two private
browser operations. Browser operations require POST from explicit **direct peer
IPs**, followed by the application's independent service-secret check. Forwarded
headers never substitute for this source check. Unknown/internal/health paths
stay private. The template preserves canonical Host, enables streaming and active
readiness, bounds bodies and disables proxy retries for OAuth and MCP writes.
See [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Before adding the site, apply the companion App's managed Caddy hardener. It
redacts raw URIs, ordinary credentials and all federation service/context/nonce
headers from runtime logs. Review existing access-log writers separately; keep
raw OAuth queries, cookies, bearers and private headers out of all log sinks.
The site adds no raw access logger.
The disposable image check renders Compose and runs this site on Caddy 2.8.4
with certificate verification, direct-peer denial, exact public/private paths,
body limits and unavailable-upstream runtime-log redaction. Its shared fixture
network does not qualify the actual three-network deployment or host routing.

The first ingress plan assumes direct TLS/DNS-only routing to TeamGrid Caddy.
Verify the reserved `mcp` hostname, DNS/ACME and existing wildcard Worker routes
before adding the record. A proxied route would require separate trusted-proxy
and source-policy qualification; do not enable forwarded-header trust broadly.
No DNS, Worker route or certificate was changed by preparation.

## Release admission and recovery

The App/API/Developer Platform normal release remains Release Pipeline v2 in
TeamGrid's `docs/production-deployment.md`. These operating artifacts are not an
alternative Production deploy helper. The separate global project and its exact
image/config/network identities must be admitted into that reviewed release plan
before any external mutation. The companion App implements the additive
`federatedMcp` manifest component, followed by `federation-staging` and
`federation-production` after the existing regional Staging/DE/US chain.
Successful protected-main SDK push CI publishes the qualified image and exact
source/digest proof; PR builds remain unpublished. No live image or deployment
is established by the draft.

Follow the App's `docs/runbooks/federated-mcp-release-v2.md` for the seven pinned
operating-file digests, predecessor identity, actual infrastructure qualification,
fixed root-owned host helper and its restricted sudo rule. Install runtime files
under the exact v2 release directory. The release lane verifies its installed
helper hashes, operator-controlled state, persisted Caddy mount and candidate
image parser before rolling replicas A then B. Its interrupted-transition journal
blocks blind retry, and the immutable ledger waits for both global receipts.
Real hosting/DB/ingress, client/vendor and first-release qualification remain
outstanding.

Qualify Staging first: isolated TLS DB/role/restore, actual regional metadata and
registrations, two replicas, ingress, workspace selection, ordinary/sensitive
Passkey consent, code publication, recovery, refresh/revoke and vendor flows.
Then admit one immutable version through the release path and permitted window,
with DE/US feature-baseline evidence, rollback identities and public/private
routing probes. Preserve existing regional connections throughout.

A global rollback replaces only the service replicas/configuration with an
admitted compatible predecessor. Retain the dedicated database, authority,
receipt recovery key and regional code/token state. Closing global `enabled` or
`writesEnabled` requires an atomic private-file replacement on every replica;
regional endpoints remain independent. A metadata-store outage is unavailable,
not permission to probe another region or recreate the database.

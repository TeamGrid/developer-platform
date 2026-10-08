# Global federated MCP service

Private, separate Node service for the full 208-tool integration. Start with
`node developer-platform/hosting/federated/main.mjs`, or build its dedicated
Dockerfile from the repository root. The public SDK remains driver-independent.
The private service pins MongoDB driver 6.21.0 in its own lockfile. Node and the
App/Mongo/SDK release families are unchanged.

This is an unqualified deployment candidate. Hosting, database/replica topology,
regional configuration, real client registrations, vendor acceptance and release
admission still require qualification. The image CI builds and tests this service. Successful SDK `main` push CI
publishes its exact image and a digest/source proof for Release Pipeline v2; PR
CI does not publish, and CI does not deploy it. See [global authority/routing design](../../../integrations/global-oauth-federation.md).

For the chosen TeamGrid-owned deployment model, see [self-hosting preparation](self-hosting.md).
It supplies digest-pinned Compose/Caddy artifacts without deploying them.

## Private inputs

Set `TEAMGRID_FEDERATION_CONFIG_FILE` to an absolute path. Both this file and its
client-policy file must be bounded UTF-8 JSON regular files, owned by the service
UID or root, readable by the service, with no group/other permission bits (0600
or 0400). Symlinks and non-regular files are rejected. This filesystem contract
is supported on Unix; this server is a Linux image. Microsoft/Windows clients
use the normal remote MCP interface.

Mount the **parent directory**, read-only for the service, and update files by
atomic rename from the trusted operator context. Binding individual files leaves
their old inode visible after a host-side rename. Projected secret symlinks must
be materialized as regular private files by the trusted deployment bootstrap.
The image runs as UID 1000; provision ownership/read access accordingly.

The configuration has version 1 and rejects unknown keys. The following template
contains deliberately invalid secret placeholders and remains disabled. Replace
inputs privately; never paste secrets into chat or command arguments.

```json
{
  "version": 1,
  "issuer": "https://mcp.teamgrid.app/",
  "resource": "https://mcp.teamgrid.app/mcp",
  "enabled": false,
  "writesEnabled": false,
  "selectionUiOrigin": "https://login.example.test/",
  "workspaceRootDomain": "teamgrid.app",
  "selectionServiceSecret": "<separate-browser-service-secret>",
  "clientPolicyFile": "/run/teamgrid-federation/clients.json",
  "mongo": {
    "uri": "mongodb://<encoded-user>:<encoded-password>@db.example.test/?replicaSet=<set-name>&tls=true&authSource=<database>",
    "database": "teamgrid_federation_<environment>"
  },
  "admission": {
    "hmacSecret": "<separate-shared-admission-secret>",
    "globalPerMinute": 6000,
    "publicPerMinute": 1200,
    "credentialPerMinute": 120
  },
  "cells": [
    {
      "region": "de",
      "cellId": "de-<actual-cell>",
      "providerUrl": "https://regional-service.example.test/internal/developer/oauth/integrations/ai-global/access",
      "serviceSecret": "<regional-service-secret>",
      "apiBaseUrl": "https://regional-api.example.test/v1",
      "apiOriginSecret": "<regional-api-origin-secret>"
    }
  ],
  "allowedOrigins": [],
  "hostClients": [],
  "listen": { "host": "0.0.0.0", "port": 8080 }
}
```

Workspace consent uses `https://<workspace>.<workspaceRootDomain>/developer/oauth/authorize`
by default. For an environment whose workspace routes use a path on the shared UI
host, explicitly set `workspaceUiMode` to `"path"`. Consent then uses
`<selectionUiOrigin><workspace>/developer/oauth/authorize`, with the same validated
workspace slug and request/region/cell binding. For TeamGrid Staging, the UI origin
is `https://staging-test.teamgrid.app/`. The path mode never takes an origin from a
browser request. Production retains its subdomain mode. Changing the mode is an
immutable service-configuration change requiring a reviewed rollout.

API origin credentials retain the regional contract: 32–512 visible ASCII
characters, including base64 punctuation. Whitespace, control characters and
non-ASCII values are rejected. Browser, admission and service secrets retain
their separate 32–256 URL-safe character contract.

Use the actual fixed DE and US entries; a cell/provider is never derived from
a request or directory response. The selection URL, placement and region/cell
must match the additional App integration. Service/browser/admission credentials
have separate purposes. Copy the matching browser-service secret to the App's
private `TEAMGRID_OAUTH_BROWSER_BROKER_SECRET` configuration. Provision the
regional recovery key and additional authority through the App release path.
No default central origin or DE placement is inferred.

OpenID identity is explicitly enabled by `oidcKeyFile`, an absolute path in the
same private read-only mount. Its bounded JSON contains `privateKeyPem` (PKCS8
RSA, 2048–4096 bits), a separate 32-byte base64url `subjectSecret`, and optionally
up to two `previousPublicKeys`. Never reuse service/admission credentials. Keys
are read at startup and errors reveal no key material. Rotate signing keys with
a reviewed service restart and retain previous public keys for in-flight token
verification; keep the subject secret stable so account identifiers do not change.

Every owning App cell must independently enable `TEAMGRID_OIDC_ENABLED=true`
and keep `EMAIL_VERIFICATION_OFF` unset. Identity scopes `openid` and `email`
remain separate from business principals and native role ceilings. The owner can
decline either disclosure during consent. UserInfo checks current access/grant,
account, client, membership, cell and verified primary email on every request.
Code/refresh responses with `openid` include a short-lived RS256 ID Token bound
to the actual account, client, issuer and original nonce. No authentication time
is invented from consent or token issuance. Discovery and public JWKS are served
only with valid explicit OpenID configuration; readiness requires both identity
scopes in every cell. `prompt=consent` follows ordinary approval. Unsupported
fresh/silent authentication and requested claims modes are rejected. Bounded
`id_token_hint` values are ignored as optional context, never decoded, persisted
or used as authentication; the existing TeamGrid browser session still requires
normal consent. This source implementation still needs real-image and
real-client qualification before activation.

The client-policy file is:

```json
{
  "version": 1,
  "cimdEnabled": false,
  "cimdAllowedOrigins": [],
  "clients": []
}
```

Fill static clients with the exact regional `_id`, `clientId`, name, callbacks,
status, auth method and up to two secret hashes. It stores no raw OAuth client
secret. For CIMD, verify and explicitly allow the real canonical HTTPS origins.
Unknown client metadata cannot add a trusted origin. `hostClients` maps verified
client IDs to the existing OpenAI/Anthropic/Microsoft presentation contracts.
Actual registrations, secret hashes and CIMD identity must match every owning
region before activation; the service does not provision or synchronize them.

Every resolution re-reads policy, including revocation before cache use and after
metadata I/O. `enabled` and `writesEnabled` also re-read service configuration;
closing the global entry therefore needs no process restart. All other service
inputs are immutable for a running instance: changing them closes that instance
until a reviewed restart. Apply closure to every replica. Existing regional
endpoints remain independent.

## Database and admission

Choose a dedicated DB named `teamgrid_federation_<environment>`. Startup accepts
only that namespace and an explicitly named, authenticated TLS replica set.
Mongo URI options are restricted to replicaSet, TLS, authSource, authMechanism
and tlsCAFile. Invalid certificate/hostname bypasses, direct/sharded/load-balanced
connections and implicit default DBs are unsupported. Driver retries and logging
are disabled; selection/connect/checkout/socket deadlines and a 20-connection
pool are bounded. See the [driver connection options](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/).

Precreate five collections: `control`, `routes`, `browsers`, `admission`, `probes`.
Give the dedicated service identity only find/insert/update/createIndex/listIndexes
on these collections; grant no regional grant/business-data access and no database
administration or collection-drop rights. The native fixture qualifies this exact
collection-scoped role and checks rejection of deletes, drops, collection creation
and access to a regional grant collection. Qualify actual provisioned credentials
and topology before deployment. See [Mongo privilege actions](https://www.mongodb.com/docs/manual/reference/privilege-actions/).
`hello` must identify the configured writable primary with session support.
All stored authority remains in the regional App; the global collections contain
routing hashes, confidential bounded browser metadata, HMAC quota counters and
readiness records.

Startup publishes an immutable deployment binding with issuer/resource and a
hash of admission configuration. Different bindings conflict instead of replacing
existing data. Every replica must use the same admission secret/limits. Changing
this binding requires a separately reviewed migration/rotation; this version has
no automatic admission-key migration. Choose the actual replica/journal topology,
network access, backup/retention and recovery before deployment. Local single-node
qualification proves protocol behavior, not Production HA or failover.

The shared fixed-window admission uses journaled majority atomic increments.
It charges a global ceiling first, then public traffic or an HMAC identity for a
syntactically valid MCP bearer. Authentication remains separate. OAuth/discovery
traffic shares the public ceiling; fabricated bearers cannot escape the global
ceiling. No IPs, raw headers, cookies, client secrets or bearers enter quota storage.
TTL retention is three minutes; limits apply explicitly within the chosen minute.
Set capacity from measured traffic; synchronize instance clocks and qualify burst
behavior and ingress admission before public activation. A quota-store outage
fails unavailable. There is no in-memory allowance.

## Readiness, ingress and shutdown

The service initializes all four TTL indexes before opening its listener.
`/healthz` is process liveness. Canonical-Host `/readyz` coalesces a bounded probe,
cached for at most ten seconds. It rechecks private client configuration, primary,
deployment binding, a majority+journaled canary write with linearizable readback,
and each fixed regional provider's authenticated HTTPS metadata. Provider issuer,
endpoints, PKCE, issuer-bearing replies, supported methods and the complete scope
catalog must match. A failed/stalled provider or storage operation is unavailable.
This is dependency readiness, not authenticated vendor/Passkey or grant qualification.

TLS ingress must preserve the exact public Host, remove untrusted routing headers
and expose only the intended public surface. Restrict `/internal/oauth/browser/*`
to the authenticated App service channel and `/readyz` to operations. Keep the
existing body/header/concurrency limits and supply the approved browser/MCP origins.
The backend listener is plain HTTP for a trusted TLS ingress; do not expose it
directly. SIGINT/SIGTERM close the handler/connections and Mongo pool. Only fixed
startup messages are logged; URLs, headers, bodies and raw errors are omitted.

## Qualification

```sh
npm run verify
docker build -f developer-platform/hosting/federated/Dockerfile \
  --build-arg SOURCE_REVISION=<exact-sha> -t teamgrid-federated-mcp:<exact-sha> .
bash developer-platform/hosting/federated/smoke-image.sh teamgrid-federated-mcp:<exact-sha>
```

`npm run verify` includes the independent private lockfile installation, production
audit and Node tests on the supported CI Node versions. The image qualification
uses two non-root read-only service containers, an ephemeral certificate-verified
HTTPS metadata provider and a disposable authenticated TLS MongoDB 8.3.8/FCV 8.0
replica set with a dedicated collection-scoped service role. The service runs in
the normal Production image mode. It checks native TTL/consistency behavior,
shared quotas, client revocation without
restart, hashed browser storage, independent closure, storage outage and graceful
SIGTERM exit. Cleanup
removes only its random containers/files. On this Mac use `DOCKER_CONTEXT=colima`.
It changes no existing local database and contacts no vendor account.

The bootstrap requires authenticated TLS Mongo connections in every mode. Fixture
admin/keyfile credentials exist only in root-owned private temporary files for
initial provisioning; the service receives only its limited identity. Its ephemeral
CA validates the database and metadata provider without certificate bypasses. The
fixture provider does not issue tokens or approve consent. Pair this check
with the existing actual SDK/App/Mongo browser/token qualification, then perform
the required real Meteor UI/DDP, Passkey, OpenAI, Claude and M365/Cowork acceptance.
Deploy only through the admitted release path with verified regional/client parity.

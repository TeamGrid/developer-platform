# Global OAuth federation

Decision date: 2026-10-04. Implementation update: 2026-10-05. Regional transport,
MCP routing, a Mongo directory adapter, public token/revocation broker and private
transactional exchange recovery are implemented in draft PRs. Browser request
persistence, workspace selection, consent resume, client/discovery wiring,
deployment and host qualification are outstanding. This document does
not authorize a Production release or claim a working public endpoint.

## Public identity and regional authority

The proposed common MCP resource is `https://mcp.teamgrid.app/mcp` with one
logical OAuth issuer, `https://mcp.teamgrid.app/`. Both remain undeployed.
Discovery must advertise exactly this resource and this single issuer. Existing
DE/US issuers, resources, grants and token formats keep their original meaning.

The regional App accepts an additional exact issuer/resource pair through an
operator-owned integration registry. Its region, cell, scope ceiling and client
metadata policy come from that App's regional configuration. A registry entry
cannot enable additional scopes, change its cell or bypass client revocation.
The authorization UI is also a fixed operator configuration. Invalid federation
configuration stops the additional authority while legacy regional endpoints
and grants remain independent.

OAuth requests, grants, principals, resource grants, code and token hashes stay
in their originating regional database. Every code exchange, refresh, access
check and revocation compares exact issuer, resource, region and cell. A global
grant cannot be presented to the legacy regional authority, or vice versa.
Authorization callbacks retain the exact logical `iss` value on approval and
denial. See [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207).

## Private regional transport

Each configured cell has a fixed regional service origin. It accepts only:

| Private operation | Selected logical OAuth operation |
| --- | --- |
| `GET /internal/developer/oauth/integrations/<id>/metadata` | Issuer metadata |
| `GET /internal/developer/oauth/integrations/<id>/authorize` | Authorization request preparation |
| `POST /internal/developer/oauth/integrations/<id>/token` | Code exchange or refresh |
| `POST /internal/developer/oauth/integrations/<id>/recover` | Read a committed private exchange receipt |
| `POST /internal/developer/oauth/integrations/<id>/revoke` | Token revocation |
| `POST /internal/developer/oauth/integrations/<id>/access` | Fresh grant verification and API delegation |
| `POST /internal/developer/oauth/integrations/<id>/admission` | Regional gateway admission |

The service transport requires the exact regional service Host and
`X-TeamGrid-OAuth-Service-Authorization: Bearer <regional service secret>`.
Public App aliases, arbitrary paths, unknown integration IDs and wrong secrets
are rejected before the selected OAuth handler runs. The service header is
removed when invoking that handler. OAuth Basic client authentication remains
separate; service credentials never stand in for the OAuth client's identity.
The private response has no browser CORS access.

The private `token` and `recover` operations additionally require a fresh
`X-TeamGrid-OAuth-Exchange-ID` (32 random bytes, base64url). Token responses use
the private `{tokenResponse, routes}` envelope; this is never returned as public
OAuth metadata. The selected client is authenticated before either operation.
The receipt binds exact logical/physical authority, normalized exchange fields,
the original body (including client-secret POST) and Basic authentication.
Recovery never consumes a code or rotates a refresh token. It rechecks the
current grant, generation, scopes, token lifetime, client and workspace and
serializes against revocation in the same transaction. At most three recoveries
are permitted within one minute. A new public exchange still follows ordinary
code/refresh reuse detection and family revocation.

Provision `TEAMGRID_OAUTH_FEDERATION_RECOVERY_KEY` privately as canonical base64
for exactly 32 random bytes. Receipts use AES-256-GCM with immutable authority/
request metadata as authenticated data. Raw token responses are never stored
unencrypted. Keep the same recovery key across the one-minute in-flight window
and rolling restart/rollback; this version has no automatic key migration.
TTL cleanup is asynchronous; availability ends at the explicit
one-minute deadline even while a stored ciphertext awaits cleanup. New receipt/
outbox index failure closes only the additional integration. Legacy regional
OAuth remains independent of this key and of federation index readiness.

The proposed additional App configuration is:

```json
[
  {
    "id": "ai-global",
    "issuer": "https://mcp.teamgrid.app/",
    "resource": "https://mcp.teamgrid.app/mcp"
  }
]
```

It belongs in `TEAMGRID_OAUTH_INTEGRATIONS_JSON`. An explicit canonical
`TEAMGRID_OAUTH_AUTHORIZATION_UI_ORIGIN` is required, or an entry can supply
`authorizationUiOrigin`. The registry allows at most eight additional pairs,
unique issuer/resource/ID values, and no `regional` override. Do not install
this configuration in Production until the public broker and routing-store
protocol have passed qualification.

## Credential routing directory

Choose a bounded hash directory instead of changing existing opaque credentials
or probing every cell. Its keys are the SHA-256 hashes of high-entropy codes,
access tokens and refresh tokens, namespaced by logical issuer/resource and
credential kind. Stored values contain only the fixed cell ID, expiry and the
minimum immutable routing generation needed for safe registration. Never store
raw credentials, business payload, user emails or workspace names there.

Routing is not authorization. Even an incorrect or stale directory entry can
reach only an operator-allowlisted cell, where the original grant is checked
again. An unknown hash reaches no cell. A directory outage, an unknown cell or
a failed provider stops processing. Never retry a credential in another cell.
Provider URLs and API URLs must not come from the directory or the client.

The implemented `createFederatedMcpGateway` requires an injected
`resolveAccessTokenCell(hash, signal)` adapter. It has no default store, token
cache or discovery fallback to another issuer. It applies ingress checks,
feature gating and admission before lookup, shares a maximum 30-second request
budget with lookup and regional execution, and keeps concurrent DE/US requests
separate. Unknown access tokens retain the global OAuth challenge; routing
outages return 503 without asking the user to create another connection.

The implemented `createMongoOAuthRoutingDirectory` takes a native Mongo replica-set
collection supplied by its operator. Initialize its TTL index before accepting
requests. Reads uniquely identify `_id`, use primary linearizable read concern
and a five-second deadline; publication uses journaled majority writes. Conditional
upsert matches the entire immutable record: any difference conflicts with the
existing `_id` instead of changing its cell, generation or expiry. A partial
two-token publication can be resumed with the same records. The broker returns
no tokens until both writes have succeeded. No eventually consistent cache or
default local store is provided. Keys and route records are confidential even
though they contain hashes. A TTL is storage cleanup, never authorization.
See [Mongo linearizable reads](https://www.mongodb.com/docs/manual/reference/read-concern-linearizable/).

Choose and qualify the actual database location, journal/replica topology,
network access, least-privilege DB role, retention and recovery before deployment.
The adapter does not provision that database or assume an existing regional DB
is suitable as the global store.

## Broker and route publication protocol

1. The public broker validates the registered client, callback, PKCE and exact
   resource. A bounded, expiring browser request handle carries no bearer or
   client secret in a URL. Authenticated workspace selection determines the
   regional cell. A region hint alone supplies no authority.
2. The selected regional App prepares the request under the global identity and
   supplies its normal consent, current membership checks and sensitive-scope
   Passkey flow. Region/cell stay bound to that request through central login.
3. Implemented: approval commits the code and a routing outbox record in the same regional
   transaction. A broker resume step publishes its hash-to-cell mapping with
   conditional insert before returning the callback code to the host. A failed
   publication must not expose a usable unrouteable code.
4. Implemented token channel: code exchange resolves the code hash once and calls only that regional
   provider. Token issuance/refresh commits hash routing events with the token
   transaction. The broker publishes both new token routes before returning the
   response. An ambiguous network outcome must not trigger blind repeated code
   exchange or refresh, because reuse intentionally revokes the token family.
   The implemented broker uses one narrowly authenticated receipt recovery,
   never a repeated issue request. A public client retry is a new exchange;
   there is no public replay exemption or indefinite raw-token retention.
5. Old code and refresh routes remain until the regional replay-detection
   retention expires. Removing a consumed refresh route immediately would hide
   proven token-family reuse from the regional authority. Access routes also
   expire independently; regional revocation is always checked freshly.
6. Revocation uses the original hash route and OAuth client authentication.
   Unknown credentials return the normal RFC 7009 no-op. Known routes stay
   long enough for replay detection and are never reassigned to another cell.

Local tests now cover receipt/outbox rollback, lost private reply after commit,
duplicate private issuance, partial publication, immutable route conflicts,
receipt expiry/tampering, later rotation, revocation and normal reuse. The optional
cross-repository qualification uses the actual App private HTTP transport, SDK
broker and native Mongo directory in one disposable database. It does not exercise
the global client registry, browser selection/resume or a real provider login.
Cross-region outage, DB failover, measured latency and full browser crash-window
qualification remain required before deployment.
Claude's documented token exchange/discovery budgets also require measured
latency against the deployed topology.

Run the combined local test from the App worktree after building the SDK. Set
`TEAMGRID_OAUTH_FEDERATION_QUALIFICATION_SDK` to the SDK's absolute
`developer-platform/packages/mcp-server/dist/index.js`, then run
`.scripts/developer-oauth-replica-set-smoke.sh` with the appropriate Docker
context. The helper creates and removes only its own random local Mongo database
and container. Ordinary App CI still qualifies regional transactions without
requiring the unpublished SDK worktree.

## Request data and rollback

The global TLS gateway processes MCP bearers and business request/response
payloads. The OAuth broker also sees authorization codes, refresh/access tokens
and client authentication during exchange. Regional database placement does not
make this exclusively regional processing. Hosting location, TLS transit,
subprocessors, logs and retention require an explicit operating configuration
and accurate privacy statements before review. The routing adapter sees only
credential hashes; observers must never receive tokens or business payloads.

Do not change existing Production feature flags, regional endpoints or
credential issuance to launch federation. Rollback can close the new global
entry independently. Keep its regional registry entries while existing global
grants need revocation/cleanup; deleting them deliberately invalidates those
global grants but must not invalidate legacy regional grants.

## Qualification evidence

Local tests cover exact authority registry matching, unchanged legacy handling,
global authorization preparation, issuer-bearing callbacks, client/service auth
separation, cross-authority code/refresh/access/revocation rejection, concurrent
DE/US MCP transport, complete 208-tool discovery, private destinations, wrong
cell/issuer/resource/workspace/expiry, admission, unknown routing and bounded
lookup failures. These are local protocol tests, not real OpenAI/Claude/M365
host acceptance or deployed cross-region latency evidence.

Relevant upstream contracts:

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Claude OAuth](https://claude.com/docs/connectors/building/authentication)
- [OpenAI review](https://developers.openai.com/plugins/deploy/app-review)
- [OAuth revocation](https://www.rfc-editor.org/rfc/rfc7009)

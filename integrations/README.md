# TeamGrid AI integrations

Implementation started on 2026-10-04. The first public OpenAI release is scoped
to the complete 208-tool business catalog (84 reads, 124 writes). Claude and
Microsoft 365 Copilot, including Cowork, use the same business contract. A full
catalog does not grant access: current roles, sharing, locks, workspace binding
and separately approved OAuth scopes still apply.

## Current implementation

- Verified OAuth client identities select consent and annotation presentation.
  ChatGPT uses `mcp/www_authenticate` in tool results. Other clients receive HTTP
  403 challenges, including closed, API-derived scopes such as delegated planning.
  Challenges preserve the previous approved scope set; refresh cannot widen it.
- Stateless non-OpenAI responses are held until tool completion, with a 2 MiB
  limit inside the existing 30-second request budget. This permits a late API
  refusal to set the HTTP status even for the SDK's legacy SSE transport.
- Claude marks every modifying action destructive for host confirmation,
  including creation. OpenAI and standard MCP retain canonical action semantics.
- Three self-contained draft packages are generated from four shared workflows,
  actual paginated `tools/list` responses and pinned official JSON schemas.
  Microsoft includes both a declarative agent/action plugin and a Cowork connector
  with agent skills; all 208 explicit tools remain represented.
- The corresponding TeamGrid app change accepts Claude Code's exact registered
  `localhost`/IP-loopback callbacks without a registration port. An ephemeral
  request port is permitted, while the code exchange binds the actual selected
  redirect exactly. Host/path/query aliases remain rejected.
- An additive App authority registry and authenticated private regional transport
  retain existing regional grants. `createFederatedMcpGateway` routes opaque
  access-token hashes to one allowlisted cell, with fresh regional authorization,
  distinct API delegations, bounded lookup and concurrent DE/US isolation.
  `createMongoOAuthRoutingDirectory` supplies immutable hash registration,
  journaled majority writes and bounded linearizable reads on a native replica-set
  collection. `createFederatedOAuthTokenBroker` routes exchange/refresh/revocation
  to that exact cell. Private recovery reads a one-minute encrypted receipt,
  rechecks current authority and never repeats issuance. Token transactions commit
  their hash outbox and receipt atomically; consent commits the code hash outbox.
  See the [global OAuth decision](global-oauth-federation.md). Browser request
  persistence, authenticated workspace selection, consent resume, global client
  registry/discovery wiring and the deployed endpoint remain outstanding.

```sh
cd developer-platform
npm ci
npm run build
npm run integrations:build
npm run integrations:check
```

The check validates OpenAI's portable manifest/MCP schema, Microsoft's app 1.29,
declarative agent 1.6 and action plugin 2.4 schemas. It checks byte-for-byte
generation, full tool/schema/scope consistency, Claude confirmation hints,
package containment, pinned schema hashes and Microsoft's conditional OAuth
reference requirement. Claude's local JSON/packaging checks are not a replacement
for its own CLI/portal validation. OpenAI extension contents also require portal
validation beyond the portable schema.

Generated files are under `plugins/{openai,claude,microsoft365}/teamgrid`.
`generated/tool-matrix.json` maps every operation, its scopes, concurrency and
host annotations. `generated/build-evidence.json` pins the API source, catalog
digest and package file digests. Its status is **draft-unqualified**. Catalog
metadata checks are not successful live calls or host acceptance.

## Remaining launch work

1. Qualify a global issuer/resource with DE/US routing, exact authority binding,
   opaque-token lookup, refresh/revocation routing and unchanged regional grants.
   `https://mcp.teamgrid.app/mcp` is a proposal; this build does not deploy it.
   The regional gateway must not accept a foreign issuer just to accommodate it.
2. Register publisher accounts and the Microsoft static OAuth client. Register
   the Microsoft callback `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`
   in TeamGrid and put the real Enterprise Token Store reference ID in config.
   Cowork and declarative plugin fields are different (`referenceId` vs
   `reference_id`) and both must reference that actual registration.
3. Verify the legal URLs for this TeamGrid product and review global gateway
   processing. Existing regional storage does not imply entirely regional data
   processing when a global TLS gateway handles payloads.
4. Resolve the hosted Claude identity mismatch or register an explicit approved
   client. On 2026-10-04, the document at
   `https://claude.ai/api/oauth/mcp-oauth-client-metadata` returned the client ID
   `https://claude.ai/oauth/mcp-oauth-client-metadata`; the latter returned HTTP
   403 in this probe. Do not relax exact identity/SSRF checks to bypass it.
   Claude Code's published document at
   `https://claude.ai/oauth/claude-code-client-metadata` matched its identity and
   listed `http://localhost/callback` and `http://127.0.0.1/callback`.
5. Build synthetic DE/US review workspaces and demonstrate reviewer access to
   sensitive consent without weakening customer Passkey policies.
6. Test each real host: login, two scope expansions, refusal, refresh, revocation,
   wrong workspace/issuer/resource/region, membership loss and workspace locks.
   Test private files/exports and all 208 operations, including uncertain writes.
   Microsoft tool selection with the full inventory requires evaluation; schema
   validity does not prove that the model reaches every operation reliably.
7. Validate each exact package in its vendor tooling and allowed public channel.
   Submit OpenAI only after full acceptance. Claude needs connector and plugin
   submissions. Microsoft public package eligibility is separate from sideloading.

Missing privacy/terms URLs become `example.invalid` values and missing Microsoft
OAuth references become `UNREGISTERED-TEAMGRID-OAUTH` in draft output. These values
are deliberate blockers and must not be submitted. The app GUID in config is a
local candidate, not evidence of a Microsoft registration. No public-release
command is provided while these launch requirements remain unqualified.

## Source and schema provenance

Official schemas are vendored in `schemas/`, with URLs, retrieval date and SHA-256
in `schemas/sources.json`. Their upstream licensing remains applicable; packaging
does not modify these schemas. The small `ajv-draft-04` development dependency
validates Microsoft's declared dialect without replacing the MCP SDK or upgrading
the app runtime. Brand PNGs render the existing TeamGrid vector mark from the app
source, at Microsoft's required 192 and 32 pixel sizes. The SVG sources are kept
under `shared/assets`; regenerate them with `rsvg-convert` when changing assets.

Relevant official documentation, checked 2026-10-04:

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI OAuth](https://developers.openai.com/plugins/build/auth)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Claude connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Claude plugin packaging](https://claude.com/docs/plugins/build)
- [Microsoft plugin schema 2.4](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4)
- [Microsoft Cowork packaging](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development)
- [Microsoft dynamic discovery](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-dynamic-tool-discovery)

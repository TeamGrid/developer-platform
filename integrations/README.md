# TeamGrid AI integrations

Implementation started on 2026-10-04. The first public OpenAI release is scoped
to the complete 208-tool business catalog (83 reads, 125 writes). Claude and
Microsoft 365 Copilot, including Cowork, use the same business contract. A full
catalog does not grant access: current roles, sharing, locks, workspace binding
and separately approved OAuth scopes still apply.

The owner confirmed **Foundster Corporate Services FZCO** as the legal publisher
on 2026-10-05. `config.json` supplies that name to OpenAI/Claude and to package
READMEs. Microsoft's developer name has a 32-character limit, so its manifest
uses the display name **Foundster**; vendor verification must confirm that
display name against the full legal entity. Product labels remain TeamGrid.
This confirmation does not establish vendor business
verification, Microsoft program enrollment or the applicability of legal URLs.

Publisher portals were inspected on 2026-10-05. OpenAI's available organization
shows **Business: Approved**; the owner confirmed this is Foundster's business
verification. This does not approve or publish the TeamGrid plugin. Microsoft
recognizes Foundster in the existing personal account's publisher information,
but only Windows Desktop Applications is registered. Its Microsoft 365 and
Copilot enrollment requires a work account; the owner deferred creation of that
account. Claude's directory validation passed on `28722ae` with three warnings
and two policy holds: the TeamGrid name and GitHub owner resemble the existing
connector `teamguide`. The portal checked the repository, 16 files, four skills
and one MCP server; a human review is still needed. Preserve the actual TeamGrid
identity rather than renaming it to avoid that review. These observations do not
establish real-host acceptance. No vendor terms were accepted or plugin published
in this inspection.

Existing public legal pages are confirmed on 2026-10-05:
[Privacy Notice](https://web.teamgrid.app/privacy) and
[Account and User Terms](https://web.teamgrid.app/terms). Both open without a
login and resolve to the current version `2026-07-14.2`, with German and English
documents naming Foundster. The Sign-up acceptance component links these same
versioned documents. Their existing integration/third-party clauses are the
starting point; the remaining review concerns the specific AI hosts, authorized
tool arguments/results, OAuth access/revocation, retention and DE processing of
US gateway payloads. Public accessibility is confirmed, not complete legal
coverage of the proposed integration. No existing legal version was edited.

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
- Claude includes the directory icon and legal-link fields. Each package README
  describes tool arguments, returned data, authorized changes and the proposed
  Germany gateway processing for both DE and US workspaces. Existing public
  legal URLs are configured; MCP-specific disclosures remain under review.
  CLI validation does not establish directory acceptance or real-host behavior.
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
  `createFederatedOAuthBrowserBroker` and `createMongoOAuthBrowserStore` now add
  persisted browser requests, authenticated workspace selection and consent resume.
  The App derives fresh workspace placement and retains sensitive-scope Passkey
  consent. Exact cookie/request/workspace/callback binding and code publication
  precede the host redirect. See the [global OAuth decision](global-oauth-federation.md).
  `createOAuthClientRegistry` supplies bounded, DNS-pinned CIMD and current static
  public/Basic/POST authentication. `createFederatedMcpRuntime` composes discovery,
  both OAuth channels and all 208 tools; its Node transport bounds OAuth bytes before
  processing. Global client revocation stops API use even before a regional policy
  rollout completes. A [private global service](../developer-platform/hosting/federated/README.md)
  now supplies executable bootstrap, private configuration/policy loading, native
  persistent stores, shared Mongo admission, bounded dependency readiness and a
  separate non-root image. Local two-instance image qualification is implemented.
  Actual operator inputs, database/hosting provisioning, real-host acceptance and
  the deployed endpoint remain outstanding.

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
reference requirement. The installed Claude Code 2.1.221 validates the package
with warnings for the directory fields; Anthropic documents warning-free support
for those fields from 2.1.281. Those fields are retained for the directory.
Claude's local JSON/packaging checks are not a replacement
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
3. Review the existing TeamGrid legal documents for the proposed MCP data flow
   and global gateway processing. Existing regional storage does not imply
   entirely regional data processing when a global TLS gateway handles payloads.
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

Relevant official documentation, checked 2026-10-04; Claude's directory checklist,
submission requirements and listing fields rechecked 2026-10-05:

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI OAuth](https://developers.openai.com/plugins/build/auth)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Claude connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Claude plugin packaging](https://claude.com/docs/plugins/build)
- [Claude directory checklist](https://claude.com/docs/plugins/pre-submission-checklist)
- [Claude directory fields](https://code.claude.com/docs/en/plugins/manifest-reference#directory-listing-fields)
- [Microsoft plugin schema 2.4](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4)
- [Microsoft Cowork packaging](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development)
- [Microsoft dynamic discovery](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-dynamic-tool-discovery)

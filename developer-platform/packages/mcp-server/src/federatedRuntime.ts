import { createFederatedMcpGateway, type FederatedMcpGatewayOptions } from './federatedGateway.js'
import { withinSignal } from './http.js'
import { createMcpNodeServer } from './httpServer.js'
import { createFederatedOAuthBrowserBroker } from './oauthBrowserBroker.js'
import type { OAuthBrowserStore } from './oauthBrowserStore.js'
import type { OAuthClientRegistry } from './oauthClientRegistry.js'
import type { OAuthRoutingDirectory } from './oauthRoutingDirectory.js'
import {
  createFederatedOAuthTokenBroker,
  OAuthBrokerInvalidClientError,
} from './oauthTokenBroker.js'
import type { createOidcSigner } from './oidcSigning.js'
import { createFederatedOidcIdentityReader, createFederatedOidcUserInfo } from './oidcUserInfo.js'
import { supportedOAuthScopes } from './toolScopes.js'

export type FederatedMcpRuntimeOptions = Omit<
  FederatedMcpGatewayOptions,
  'resolveAccessTokenCell' | 'toolProfile' | 'writesEnabled' | 'verifyOAuthClient'
> & {
  writesEnabled(): boolean
  directory: OAuthRoutingDirectory
  browserStore: OAuthBrowserStore
  clients: OAuthClientRegistry
  selectionUiOrigin: string
  workspaceRootDomain: string
  workspaceUiMode?: 'subdomain' | 'path'
  selectionServiceSecret: string
  ready(): Promise<boolean>
  oidc?: { signer: ReturnType<typeof createOidcSigner>; subject(subjectId: string): string }
}
const responseHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}

/** Complete 197-tool global HTTP composition. Storage/index initialization remains operator-owned. */
export function createFederatedMcpRuntime(options: FederatedMcpRuntimeOptions) {
  const resource = new URL(options.resourceUrl),
    issuer = new URL(options.issuerUrl)
  if (
    resource.origin !== issuer.origin ||
    issuer.pathname !== '/' ||
    ['/oauth/', '/.well-known/', '/internal/'].some((prefix) =>
      resource.pathname.startsWith(prefix),
    )
  ) {
    throw new Error('Federated runtime requires one canonical public origin.')
  }
  const cells = options.cells.map((cell) => ({
    cellId: cell.cellId,
    region: cell.region,
    serviceSecret: cell.serviceSecret,
    providerBaseUrl: new URL('./', cell.providerUrl).href,
  }))
  const budget = options.requestTimeoutMs ?? 30000
  const authorizationScopes = [
    ...supportedOAuthScopes,
    ...(options.oidc ? ['openid', 'email'] : []),
  ]
  const gateway = createFederatedMcpGateway({
    ...options,
    toolProfile: 'full',
    resolveAccessTokenCell: (hash, signal) => options.directory.resolve('access', hash, signal),
    verifyOAuthClient: async (clientId, signal) => {
      try {
        return (await options.clients.resolve(clientId, signal)).status === 'active'
      } catch (error) {
        if (error instanceof OAuthBrokerInvalidClientError) return false
        throw error
      }
    },
  })
  const brokerOptions = {
    issuer: issuer.href,
    resource: resource.href,
    cells,
    directory: options.directory,
    scopes: authorizationScopes,
    enabled: options.enabled,
    admit: options.admitRequest,
    fetch: options.fetch,
    requestTimeoutMs: budget,
  }
  const browser = createFederatedOAuthBrowserBroker({
    ...brokerOptions,
    selectionUiOrigin: options.selectionUiOrigin,
    workspaceRootDomain: options.workspaceRootDomain,
    workspaceUiMode: options.workspaceUiMode,
    selectionServiceSecret: options.selectionServiceSecret,
    store: options.browserStore,
    client: (clientId, signal) => options.clients.resolve(clientId, signal),
  })
  const oidc = options.oidc
  const identityOptions = options.oidc
    ? {
        ...brokerOptions,
        subject: options.oidc.subject,
        client: (clientId: string, signal: AbortSignal) =>
          options.clients.resolve(clientId, signal),
      }
    : undefined
  const readIdentity = identityOptions && createFederatedOidcIdentityReader(identityOptions)
  const userInfo = identityOptions && createFederatedOidcUserInfo(identityOptions)
  const tokens = createFederatedOAuthTokenBroker({
    ...brokerOptions,
    authenticateClient: (parameters, authorization, signal) =>
      options.clients.authenticate(parameters, authorization, signal),
    ...(oidc && readIdentity
      ? {
          issueIdToken: async (input) => {
            const identity = await readIdentity(input.accessToken, input.signal)
            if (
              identity instanceof Response ||
              identity.clientId !== input.clientId ||
              [...identity.scopes].sort().join(' ') !== [...input.scopes].sort().join(' ')
            ) {
              throw new Error('OpenID identity is unavailable.')
            }
            return oidc.signer.sign({
              subject: identity.subject,
              clientId: identity.clientId,
              accessExpiresAt: Date.parse(identity.expiresAt) / 1000,
              authorizationExpiresAt: Date.parse(identity.expiresAt) / 1000,
              ...(identity.nonce === undefined ? {} : { nonce: identity.nonce }),
            })
          },
        }
      : {}),
  })
  let closed = false
  const failure = (status: number, error: string) =>
    Response.json({ error }, { status, headers: responseHeaders })
  const fetchRequest = async (request: Request) => {
    if (closed) return failure(503, 'temporarily_unavailable')
    const url = new URL(request.url)
    if (
      url.origin !== issuer.origin ||
      url.username ||
      url.password ||
      url.hash ||
      (request.headers.has('host') && request.headers.get('host') !== issuer.host)
    ) {
      return failure(421, 'invalid_request')
    }
    const openidMetadata = url.pathname === '/.well-known/openid-configuration'
    const jwks = url.pathname === '/oauth/jwks'
    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      (options.oidc && (openidMetadata || jwks))
    ) {
      if (request.method !== 'GET' || url.search) return failure(405, 'invalid_request')
      if (!options.enabled()) return failure(503, 'temporarily_unavailable')
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(budget)])
      try {
        if (!(await withinSignal(options.admitRequest(request), signal))) {
          return new Response(null, {
            status: 429,
            headers: { ...responseHeaders, 'Retry-After': '60' },
          })
        }
        signal.throwIfAborted()
        if (jwks && oidc) return Response.json(oidc.signer.jwks(), { headers: responseHeaders })
        return Response.json(
          {
            issuer: issuer.href,
            authorization_endpoint: new URL('/oauth/authorize', issuer).href,
            token_endpoint: new URL('/oauth/token', issuer).href,
            revocation_endpoint: new URL('/oauth/revoke', issuer).href,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: [
              'none',
              'client_secret_basic',
              'client_secret_post',
            ],
            revocation_endpoint_auth_methods_supported: [
              'none',
              'client_secret_basic',
              'client_secret_post',
            ],
            client_id_metadata_document_supported: options.clients.metadataSupported(),
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
            scopes_supported: authorizationScopes,
            ...(options.oidc
              ? {
                  userinfo_endpoint: new URL('/oauth/userinfo', issuer).href,
                  jwks_uri: new URL('/oauth/jwks', issuer).href,
                  subject_types_supported: ['public'],
                  id_token_signing_alg_values_supported: ['RS256'],
                  claims_supported: [
                    'iss',
                    'sub',
                    'aud',
                    'iat',
                    'exp',
                    'nonce',
                    'email',
                    'email_verified',
                  ],
                }
              : {}),
          },
          { headers: responseHeaders },
        )
      } catch {
        return failure(503, 'temporarily_unavailable')
      }
    }
    if (userInfo && url.pathname === '/oauth/userinfo') return userInfo(request)
    if (['/oauth/token', '/oauth/revoke'].includes(url.pathname)) return tokens(request)
    if (
      [
        '/oauth/authorize',
        '/oauth/continue',
        '/oauth/resume',
        '/internal/oauth/browser/details',
        '/internal/oauth/browser/select',
      ].includes(url.pathname)
    )
      return browser(request)
    return gateway.fetch(request)
  }
  return {
    resourceUrl: resource.href,
    fetch: fetchRequest,
    ready: async () =>
      !closed &&
      options.enabled() &&
      (await withinSignal(options.ready(), AbortSignal.timeout(5000))),
    close: async () => {
      closed = true
      await gateway.close()
    },
  }
}

/** TLS ingress preserves Host; OAuth bodies are bounded before the broker sees them. */
export function createFederatedMcpNodeServer(
  resourceUrl: string,
  runtime: ReturnType<typeof createFederatedMcpRuntime>,
) {
  const resource = new URL(resourceUrl)
  if (resource.href !== runtime.resourceUrl)
    throw new Error('Global Node server resource mismatch.')
  return createMcpNodeServer(resourceUrl, runtime, {
    ready: runtime.ready,
    maxBodyBytes: (pathname) => (pathname === resource.pathname ? 8 * 1024 * 1024 : 16384),
  })
}

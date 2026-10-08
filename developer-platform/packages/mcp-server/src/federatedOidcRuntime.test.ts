import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createFederatedMcpRuntime } from './federatedRuntime.js'
import { createOAuthClientRegistry } from './oauthClientRegistry.js'
import { oauthRoutingRecordId } from './oauthRoutingDirectory.js'
import { createOidcSigner } from './oidcSigning.js'
import { createOidcSubject } from './oidcUserInfo.js'

const issuer = 'https://mcp.example.test/',
  resource = `${issuer}mcp`
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const now = Math.floor(Date.now() / 1000) * 1000
  const state = { revoked: false, verified: true, proofClient: 'host1' }
  const accessToken = `tg_mcp_at_v1_${'a'.repeat(43)}`
  const refreshToken = `tg_mcp_rt_v1_${'r'.repeat(43)}`
  const scopes = ['email', 'openid', 'workspace:read']
  const subject = createOidcSubject(issuer, Buffer.alloc(32, 9))
  const signer = createOidcSigner({ issuer, privateKeyPem: key })
  const directory = { resolve: vi.fn(async () => 'de-test'), register: vi.fn(async () => {}) }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    expect(new Headers(init?.headers).get('X-TeamGrid-OAuth-Service-Authorization')).toBe(
      `Bearer ${'s'.repeat(48)}`,
    )
    if (url.endsWith('/userinfo'))
      return Response.json({
        issuer,
        resource,
        region: 'de',
        cellId: 'de-test',
        clientId: state.proofClient,
        clientRecordId: 'registered-client-0001',
        subjectId: 'real-account-id',
        scopes,
        expiresAt: new Date(now + 300000).toISOString(),
        nonce: 'original-request-nonce',
        email: 'verified@example.test',
        emailVerified: state.verified,
      })
    if (url.endsWith('/token'))
      return Response.json({
        tokenResponse: {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 300,
          scope: scopes.join(' '),
        },
        routes: (['access', 'refresh'] as const).map((kind) => {
          const hash = digest(kind === 'access' ? accessToken : refreshToken)
          return {
            _id: oauthRoutingRecordId(issuer, resource, kind, hash),
            issuer,
            resource,
            region: 'de',
            cellId: 'de-test',
            kind,
            hash,
            registrationId: 'b'.repeat(64),
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 300000).toISOString(),
          }
        }),
      })
    throw new Error('Unexpected private fixture destination')
  })
  const clients = createOAuthClientRegistry({
    registeredClients: () => [
      {
        _id: 'registered-client-0001',
        clientId: 'host1',
        name: 'Host',
        redirectUris: ['https://host.example.test/callback'],
        status: state.revoked ? 'revoked' : 'active',
      },
    ],
    metadataSupported: () => false,
    allowedMetadataOrigins: () => [],
  })
  const runtime = createFederatedMcpRuntime({
    issuerUrl: issuer,
    resourceUrl: resource,
    cells: [
      {
        region: 'de',
        cellId: 'de-test',
        serviceSecret: 's'.repeat(48),
        providerUrl:
          'https://de.example.test/internal/developer/oauth/integrations/ai-global/access',
        apiBaseUrl: 'https://api-de.example.test/v1',
        apiOriginSecret: 'o'.repeat(48),
      },
    ],
    directory,
    clients,
    browserStore: { insert: async () => {}, read: async () => null, transition: async () => false },
    selectionUiOrigin: 'https://login.example.test/',
    workspaceRootDomain: 'example.test',
    selectionServiceSecret: 'b'.repeat(48),
    enabled: () => true,
    writesEnabled: () => true,
    ready: async () => true,
    admitRequest: async () => true,
    fetch: fetcher,
    oidc: { signer, subject },
  })
  const token = () =>
    runtime.fetch(
      new Request(`${issuer}oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'host1',
          code: 'c'.repeat(43),
          code_verifier: 'v'.repeat(64),
          redirect_uri: 'https://host.example.test/callback',
          resource,
        }),
      }),
    )
  const userInfo = () =>
    runtime.fetch(
      new Request(`${issuer}oauth/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    )
  return { runtime, signer, subject, state, fetcher, directory, token, userInfo }
}

describe('federated OpenID runtime composition', () => {
  it('discovers one issuer and verifies its code-flow ID Token with its published JWKS', async () => {
    const f = fixture()
    try {
      const discovery = await (
        await f.runtime.fetch(new Request(`${issuer}.well-known/openid-configuration`))
      ).json()
      expect(discovery).toMatchObject({
        issuer,
        userinfo_endpoint: `${issuer}oauth/userinfo`,
        jwks_uri: `${issuer}oauth/jwks`,
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      })
      expect(discovery.scopes_supported).toContain('openid')
      expect(discovery.scopes_supported).toContain('email')
      const response = await f.token()
      expect(response.status).toBe(200)
      const body = await response.json()
      const [header, payload, signature] = body.id_token.split('.')
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
      const jwks = await (await f.runtime.fetch(new Request(discovery.jwks_uri))).json()
      const publicKey = jwks.keys.find((value: { kid: string }) => value.kid === decodedHeader.kid)
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: publicKey, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true)
      expect(claims).toMatchObject({
        iss: issuer,
        aud: 'host1',
        sub: f.subject('real-account-id'),
        nonce: 'original-request-nonce',
      })
      expect(claims.exp - claims.iat).toBeGreaterThan(0)
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(300)
      expect(claims).not.toHaveProperty('auth_time')
      expect(await (await f.userInfo()).json()).toEqual({
        sub: claims.sub,
        email: 'verified@example.test',
        email_verified: true,
      })
      const invalidBearer = await f.runtime.fetch(
        new Request(`${issuer}oauth/userinfo`, {
          headers: { Authorization: `Bearer ${body.id_token}` },
        }),
      )
      expect(invalidBearer.status).toBe(401)
      expect(f.directory.register).toHaveBeenCalledOnce()
    } finally {
      await f.runtime.close()
    }
  })

  it('refuses fresh identity inconsistencies instead of issuing an unverifiable ID Token', async () => {
    const f = fixture()
    try {
      f.state.verified = false
      expect((await f.token()).status).toBe(503)
      expect((await f.userInfo()).status).toBe(401)
      f.state.verified = true
      f.state.proofClient = 'another-client'
      expect((await f.token()).status).toBe(503)
      f.state.proofClient = 'host1'
      f.state.revoked = true
      expect((await f.userInfo()).status).toBe(401)
    } finally {
      await f.runtime.close()
    }
  })
})

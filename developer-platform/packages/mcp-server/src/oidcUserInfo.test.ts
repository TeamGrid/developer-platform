import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'
import { createFederatedOidcUserInfo, createOidcSubject } from './oidcUserInfo.js'

const issuer = 'https://mcp.example.test/'
const resource = `${issuer}mcp`
const token = `tg_mcp_at_v1_${'a'.repeat(43)}`
const now = new Date('2030-01-01T00:00:00Z')
function fixture() {
  const proof = {
    issuer,
    resource,
    region: 'de',
    cellId: 'de-test',
    clientId: 'host',
    clientRecordId: 'registered-host',
    subjectId: 'real-account-id',
    scopes: ['workspace:read', 'openid', 'email'],
    expiresAt: new Date(+now + 60000).toISOString(),
    email: 'verified@example.test',
    emailVerified: true,
  }
  const cells = ['de', 'us'].map((region) => ({
    cellId: `${region}-test`,
    region,
    providerBaseUrl: `https://${region}.example.test/internal/developer/oauth/integrations/ai-global/`,
    serviceSecret: region.repeat(32),
  }))
  const directory = { resolve: vi.fn(async () => 'de-test'), register: vi.fn(async () => {}) }
  const client = vi.fn(async () => ({ _id: 'registered-host', clientId: 'host', status: 'active' }))
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(proof))
  const options = {
    issuer,
    resource,
    cells,
    directory,
    client,
    fetch,
    scopes: proof.scopes,
    subject: createOidcSubject(issuer, Buffer.alloc(32, 7)),
    enabled: () => true,
    admit: async () => true,
    now: () => now,
  }
  const request = (url = `${issuer}oauth/userinfo`, init: RequestInit = {}) =>
    new Request(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    })
  return { proof, cells, directory, client, fetch, options, request }
}

describe('federated OpenID UserInfo', () => {
  it('resolves only the access hash and contacts exactly its fixed cell', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    const response = await handle(f.request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sub: f.options.subject(f.proof.subjectId),
      email: f.proof.email,
      email_verified: true,
    })
    expect(f.directory.resolve).toHaveBeenCalledWith(
      'access',
      createHash('sha256').update(token).digest('hex'),
      expect.any(AbortSignal),
    )
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, init] = f.fetch.mock.calls[0] ?? []
    expect(url).toBe(`${f.cells[0]?.providerBaseUrl}userinfo`)
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${f.cells[0]?.serviceSecret}`,
    })
    expect(JSON.parse(String(init?.body))).toEqual({ access_token: token })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('reads current verified email on every request and minimizes openid-only responses', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    await handle(f.request())
    f.proof.email = 'changed-and-verified@example.test'
    expect(await (await handle(f.request())).json()).toMatchObject({ email: f.proof.email })
    f.proof.scopes = ['workspace:read', 'openid']
    expect(await (await handle(f.request())).json()).toEqual({
      sub: f.options.subject(f.proof.subjectId),
    })
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })

  it('never equates password/Passkey login with verified email ownership', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    f.proof.emailVerified = false
    const response = await handle(f.request())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_token' })
    f.proof.emailVerified = true
    f.proof.email = 'invalid email'
    expect((await handle(f.request())).status).toBe(401)
  })

  it('refuses missing identity consent and wrong authority, cell, scope and expiry', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    f.proof.scopes = ['workspace:read']
    expect((await handle(f.request())).status).toBe(403)
    f.proof.scopes = ['workspace:read', 'openid', 'email']
    for (const change of [
      { issuer: 'https://other.example.test/' },
      { resource: `${issuer}other` },
      { region: 'us' },
      { cellId: 'us-test' },
      { expiresAt: now.toISOString() },
      { expiresAt: new Date(+now + 301000).toISOString() },
      { scopes: ['openid', 'email'] },
      { scopes: ['workspace:read', 'openid', 'email', 'unissued:scope'] },
      { scopes: ['workspace:read', 'openid', 'openid'] },
    ]) {
      f.fetch.mockImplementationOnce(async () => Response.json({ ...f.proof, ...change }))
      expect((await handle(f.request())).status).toBe(401)
    }
  })

  it('checks live registration and distinguishes revocation from registry outages', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    for (const change of [
      { _id: 'replacement-registration' },
      { clientId: 'other' },
      { status: 'revoked' },
    ]) {
      f.client.mockResolvedValueOnce({
        _id: 'registered-host',
        clientId: 'host',
        status: 'active',
        ...change,
      })
      expect((await handle(f.request())).status).toBe(401)
    }
    f.client.mockRejectedValueOnce(new OAuthBrokerInvalidClientError())
    expect((await handle(f.request())).status).toBe(401)
    f.client.mockRejectedValueOnce(new Error('private-registry-detail'))
    const response = await handle(f.request())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-registry-detail')
  })

  it('refuses query/body credentials, wrong hosts and non-access credentials before routing', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    for (const request of [
      f.request(`${issuer}oauth/userinfo?access_token=forbidden`),
      f.request('https://other.example.test/oauth/userinfo'),
      f.request(undefined, { headers: { Host: 'other.example.test' } }),
      f.request(undefined, { method: 'POST', body: 'access_token=forbidden' }),
      f.request(undefined, { headers: { Authorization: 'Bearer an-id-token-or-refresh-token' } }),
    ])
      expect((await handle(request)).status).toBeGreaterThanOrEqual(400)
    expect(f.directory.resolve).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('never falls back to another cell and does not expose malformed provider content', async () => {
    const f = fixture(),
      handle = createFederatedOidcUserInfo(f.options)
    f.directory.resolve.mockResolvedValueOnce(null as unknown as string)
    expect((await handle(f.request())).status).toBe(401)
    expect(f.fetch).not.toHaveBeenCalled()
    for (const response of [
      new Response('private-provider-detail', { status: 503 }),
      new Response('private-provider-detail', { status: 200 }),
      Response.json({ ...f.proof, privateDetail: 'never-reflect' }),
      new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      f.fetch.mockResolvedValueOnce(response)
      const result = await handle(f.request())
      expect(result.status).toBe(503)
      expect(await result.text()).toBe('{"error":"temporarily_unavailable"}')
    }
    expect(
      f.fetch.mock.calls.every(([url]) => url === `${f.cells[0]?.providerBaseUrl}userinfo`),
    ).toBe(true)
  })

  it('honors cancellation when an infrastructure dependency ignores its signal', async () => {
    const f = fixture(),
      controller = new AbortController()
    let started: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    f.fetch.mockImplementationOnce(async () => {
      started()
      return await new Promise<Response>(() => {})
    })
    const pending = createFederatedOidcUserInfo(f.options)(
      f.request(undefined, { signal: controller.signal }),
    )
    await reached
    controller.abort()
    expect((await pending).status).toBe(503)
    expect(f.client).not.toHaveBeenCalled()
  })

  it('does not disclose identity after the token expires during a client lookup', async () => {
    const f = fixture()
    const times = [now, new Date(+now + 60000)]
    f.options.now = () => times.shift() ?? new Date(+now + 60000)
    expect((await createFederatedOidcUserInfo(f.options)(f.request())).status).toBe(401)
  })

  it('keeps opaque account subjects stable and copies the dedicated secret', () => {
    const secret = Buffer.alloc(32, 1),
      derive = createOidcSubject(issuer, secret)
    const original = derive('real-account-id')
    secret.fill(2)
    expect(derive('real-account-id')).toBe(original)
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(derive('another-account')).not.toBe(original)
    expect(
      createOidcSubject('https://another.example.test/', Buffer.alloc(32, 1))('real-account-id'),
    ).not.toBe(original)
    expect(() => derive('email@example.test')).toThrow('unavailable')
    expect(() => createOidcSubject(issuer, Buffer.alloc(8))).toThrow('unavailable')
  })
})

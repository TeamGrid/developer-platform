import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type OAuthRoutingRecord, oauthRoutingRecordId } from './oauthRoutingDirectory.js'
import {
  createFederatedOAuthTokenBroker,
  OAuthBrokerInvalidClientError,
} from './oauthTokenBroker.js'

const issuer = 'https://mcp.example.test/'
const resource = `${issuer}mcp`
const code = 'c'.repeat(43)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenResponse = {
  access_token: `tg_mcp_at_v1_${'a'.repeat(43)}`,
  refresh_token: `tg_mcp_rt_v1_${'r'.repeat(43)}`,
  token_type: 'Bearer',
  expires_in: 300,
  scope: 'workspace:read',
}
function publication(cellId = 'de-test', region = 'de') {
  const time = new Date()
  return {
    tokenResponse,
    routes: (['access', 'refresh'] as const).map((kind) => {
      const digest = hash(
        kind === 'access' ? tokenResponse.access_token : tokenResponse.refresh_token,
      )
      return {
        _id: oauthRoutingRecordId(issuer, resource, kind, digest),
        issuer,
        resource,
        cellId,
        region,
        kind,
        hash: digest,
        registrationId: 'b'.repeat(64),
        createdAt: time.toISOString(),
        expiresAt: new Date(+time + 86400000).toISOString(),
      }
    }),
  }
}
function harness(timeout = 30000) {
  const calls: { url: string; options: RequestInit }[] = []
  const lookups: { kind: string; hash: string }[] = []
  const registered: OAuthRoutingRecord[][] = []
  let enabled = true,
    admitted = true,
    route: string | null = 'de-test'
  let authenticate = async () => {}
  let fetcher = async () => Response.json(publication())
  let write = async (values: readonly OAuthRoutingRecord[]) => {
    registered.push([...values])
  }
  const broker = createFederatedOAuthTokenBroker({
    requestTimeoutMs: timeout,
    issuer,
    resource,
    scopes: ['workspace:read'],
    cells: [
      {
        cellId: 'de-test',
        region: 'de',
        serviceSecret: 'd'.repeat(48),
        providerBaseUrl:
          'https://mcp-de.example.test/internal/developer/oauth/integrations/ai-global/',
      },
      {
        cellId: 'us-test',
        region: 'us',
        serviceSecret: 'u'.repeat(48),
        providerBaseUrl:
          'https://mcp-us.example.test/internal/developer/oauth/integrations/ai-global/',
      },
    ],
    enabled: () => enabled,
    admit: async () => admitted,
    authenticateClient: () => authenticate(),
    directory: {
      resolve: async (kind, value) => {
        lookups.push({ kind, hash: value })
        return route
      },
      register: (values) => write(values),
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options: options ?? {} })
      return fetcher()
    },
  })
  const request = (
    patch: Record<string, string> = {},
    init: RequestInit = {},
    path = '/oauth/token',
  ) => {
    const parameters = {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'v'.repeat(64),
      client_id: 'host1',
      redirect_uri: 'https://host.example.test/callback',
      resource,
      ...patch,
    }
    return broker(
      new Request(new URL(path, issuer), {
        method: 'POST',
        body: new URLSearchParams(parameters),
        ...init,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...init.headers },
      }),
    )
  }
  return {
    request,
    broker,
    calls,
    lookups,
    registered,
    route: (value: string | null) => {
      route = value
    },
    gate: (value: boolean) => {
      enabled = value
    },
    admission: (value: boolean) => {
      admitted = value
    },
    fetch: (value: typeof fetcher) => {
      fetcher = value
    },
    auth: (value: typeof authenticate) => {
      authenticate = value
    },
    write: (value: typeof write) => {
      write = value
    },
  }
}

describe('Federated OAuth token broker', () => {
  it('routes only the credential hash and returns tokens only after both routes are published', async () => {
    const h = harness()
    const result = await h.request({}, { headers: { Authorization: 'Basic aG9zdDE6c2VjcmV0' } })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual(tokenResponse)
    expect(h.lookups).toEqual([{ kind: 'code', hash: hash(code) }])
    expect(h.registered[0]).toHaveLength(2)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toContain('mcp-de.example.test/internal/')
    const headers = new Headers(h.calls[0]?.options.headers)
    expect(headers.get('X-TeamGrid-OAuth-Service-Authorization')).toBe(`Bearer ${'d'.repeat(48)}`)
    expect(headers.get('Authorization')).toBe('Basic aG9zdDE6c2VjcmV0')
    expect(headers.get('X-TeamGrid-OAuth-Exchange-ID')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.headers.get('cache-control')).toBe('no-store')
  })
  it('recovers an ambiguous exchange once, using the same operation and exact original request', async () => {
    const h = harness()
    let calls = 0
    h.fetch(async () => {
      if (++calls === 1) throw new Error('Lost response')
      return Response.json(publication())
    })
    expect((await h.request()).status).toBe(200)
    expect(h.calls.map((call) => new URL(call.url).pathname.split('/').at(-1))).toEqual([
      'token',
      'recover',
    ])
    expect(h.calls[0]?.options.body).toBe(h.calls[1]?.options.body)
    const operation = (index: number) =>
      new Headers(h.calls[index]?.options.headers).get('X-TeamGrid-OAuth-Exchange-ID')
    expect(operation(0)).toBe(operation(1))
  })
  it('does not retry issuance or switch cells when recovery is missing or unavailable', async () => {
    const h = harness()
    h.fetch(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }))
    const result = await h.request()
    expect(result.status).toBe(503)
    expect(h.calls).toHaveLength(2)
    expect(h.calls.every((call) => call.url.startsWith('https://mcp-de.'))).toBe(true)
    expect(h.registered).toHaveLength(0)
  })
  it('never returns token material on route publication failure or wrong provider binding', async () => {
    const h = harness()
    h.write(async () => {
      throw new Error('Storage secret')
    })
    const result = await h.request()
    expect(result.status).toBe(503)
    expect(await result.text()).toBe('{"error":"temporarily_unavailable"}')
    const wrong = harness()
    wrong.fetch(async () => Response.json(publication('us-test', 'us')))
    expect((await wrong.request()).status).toBe(503)
    expect(wrong.registered).toHaveLength(0)
  })
  it('authenticates before lookup and separates rejected identity from infrastructure failure', async () => {
    const h = harness()
    h.auth(async () => {
      throw new OAuthBrokerInvalidClientError()
    })
    expect((await h.request()).status).toBe(400)
    expect(h.lookups).toHaveLength(0)
    h.auth(async () => {
      throw new Error('Registry outage')
    })
    expect((await h.request()).status).toBe(503)
    expect(h.lookups).toHaveLength(0)
  })
  it('rejects wrong resources, duplicate parameters and injected private transport headers', async () => {
    const h = harness()
    expect((await h.request({ resource: 'https://evil.example.test/mcp' })).status).toBe(400)
    expect(
      (await h.request({}, { headers: { 'X-TeamGrid-OAuth-Exchange-ID': 'e'.repeat(43) } })).status,
    ).toBe(400)
    expect((await h.request({}, { body: 'client_id=one&client_id=two' })).status).toBe(400)
    expect((await h.request({}, {}, '/oauth/token?code=secret')).status).toBe(421)
    expect(h.lookups).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })
  it('feature gating, admission, unknown credentials and unknown cells contact no provider', async () => {
    const h = harness()
    h.gate(false)
    expect((await h.request()).status).toBe(503)
    h.gate(true)
    h.admission(false)
    expect((await h.request()).status).toBe(429)
    h.admission(true)
    h.route(null)
    expect((await h.request()).status).toBe(400)
    h.route('unknown')
    expect((await h.request()).status).toBe(503)
    expect(h.calls).toHaveLength(0)
  })
  it('RFC 7009 unknown-token revocation remains an authenticated no-op', async () => {
    const h = harness()
    h.route(null)
    const result = await h.broker(
      new Request(`${issuer}oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'host1', token: tokenResponse.refresh_token }),
      }),
    )
    expect(result.status).toBe(200)
    expect(await result.text()).toBe('')
    expect(h.lookups[0]).toEqual({ kind: 'refresh', hash: hash(tokenResponse.refresh_token) })
    expect(h.calls).toHaveLength(0)
  })
  it('preserves a fresh regional client rejection and its Basic authentication challenge', async () => {
    const h = harness()
    h.fetch(async () =>
      Response.json({ error: 'invalid_client', internal: 'never exposed' }, { status: 401 }),
    )
    const result = await h.request({}, { headers: { Authorization: 'Basic aG9zdDE6c2VjcmV0' } })
    expect(result.status).toBe(401)
    expect(result.headers.get('www-authenticate')).toBe('Basic realm="TeamGrid OAuth"')
    expect(await result.json()).toEqual({ error: 'invalid_client' })
    expect(h.calls).toHaveLength(1)
  })
  it('bounds request bytes and uncooperative client authentication', async () => {
    const h = harness()
    expect((await h.request({}, { body: 'a'.repeat(16385) })).status).toBe(413)
    expect(h.lookups).toHaveLength(0)
    const stalled = harness(20)
    stalled.auth(() => new Promise(() => {}))
    expect((await stalled.request()).status).toBe(503)
    expect(stalled.lookups).toHaveLength(0)
    expect(stalled.calls).toHaveLength(0)
  })
  it('distinguishes withdrawn workspace authority and regional rate limiting from an outage', async () => {
    const h = harness()
    h.fetch(async () => Response.json({ error: 'access_denied' }, { status: 400 }))
    const denied = await h.request()
    expect(denied.status).toBe(400)
    expect(await denied.json()).toEqual({ error: 'invalid_grant' })
    h.fetch(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 429 }))
    const limited = await h.request()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(h.registered).toHaveLength(0)
  })
})

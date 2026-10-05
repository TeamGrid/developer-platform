import { createHash } from 'node:crypto'
import { request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { createFederatedMcpNodeServer, createFederatedMcpRuntime } from './federatedRuntime.js'
import { responseFixture } from './fixtures.testSupport.js'
import type { OAuthBrowserRecord } from './oauthBrowserStore.js'
import { createOAuthClientRegistry } from './oauthClientRegistry.js'
import { supportedOAuthScopes } from './toolScopes.js'

const issuer = 'https://mcp.example.test/',
  resource = `${issuer}mcp`
const client = {
  _id: 'registered-client-0001',
  clientId: 'host1',
  name: 'Test host',
  redirectUris: ['https://host.example.test/callback'],
  status: 'active' as const,
}
function harness(timeout = 30000, workspaceUiMode?: 'subdomain' | 'path') {
  const state = {
    enabled: true,
    admitted: true,
    ready: true,
    stalled: false,
    revoked: false,
    clientUnavailable: false,
  }
  const records = new Map<string, OAuthBrowserRecord>()
  const directory = {
    register: vi.fn(async () => {}),
    resolve: vi.fn(async () => null as string | null),
  }
  const browserStore = {
    insert: async (record: OAuthBrowserRecord) => {
      records.set(record._id, record)
    },
    read: async (id: string) => records.get(id) ?? null,
    transition: async (before: OAuthBrowserRecord, after: OAuthBrowserRecord) => {
      if (JSON.stringify(records.get(before._id)) !== JSON.stringify(before)) return false
      records.set(before._id, after)
      return true
    },
  }
  const clients = createOAuthClientRegistry({
    registeredClients: () => {
      if (state.clientUnavailable) throw new Error('Registry fixture unavailable')
      return [{ ...client, status: state.revoked ? 'revoked' : 'active' }]
    },
    metadataSupported: () => false,
    allowedMetadataOrigins: () => [],
  })
  const now = Date.now()
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('https://api-de.example.test/v1/'))
      return Response.json(responseFixture('getWorkspace', 'team1'), {
        headers: { 'X-TeamGrid-Resource-CAS': 'required-v1' },
      })
    if (url !== 'https://de.example.test/internal/developer/oauth/integrations/ai-global/access')
      throw new Error('Unexpected fixture destination')
    return Response.json({
      authorization: {
        active: true,
        audience: resource,
        issuer,
        expiresAt: Math.floor(now / 1000) + 300,
        clientId: client.clientId,
        subjectId: 'user1',
        workspaceId: 'team1',
        grantId: 'grant1',
        region: 'de',
        cellId: 'de-test',
        scopes: ['workspace:read', 'projects:read', 'tasks:read', 'time-entries:read'],
      },
      delegation: {
        token: `tg_oa_v2_de_de-test_${'b'.repeat(24)}_${'c'.repeat(64)}`,
        expiresAt: new Date(now + 300000).toISOString(),
        workspaceId: 'team1',
        scopes: ['workspace:read', 'projects:read', 'tasks:read', 'time-entries:read'],
      },
    })
  })
  const runtime = createFederatedMcpRuntime({
    issuerUrl: issuer,
    resourceUrl: resource,
    cells: [
      {
        cellId: 'de-test',
        region: 'de',
        providerUrl:
          'https://de.example.test/internal/developer/oauth/integrations/ai-global/access',
        serviceSecret: 's'.repeat(48),
        apiBaseUrl: 'https://api-de.example.test/v1',
      },
    ],
    directory,
    browserStore,
    clients,
    selectionUiOrigin: 'https://login.example.test/',
    workspaceRootDomain: 'example.test',
    workspaceUiMode,
    selectionServiceSecret: 'b'.repeat(48),
    enabled: () => state.enabled,
    writesEnabled: () => true,
    ready: async () => state.ready,
    requestTimeoutMs: timeout,
    admitRequest: async () => (state.stalled ? new Promise(() => {}) : state.admitted),
    fetch: fetcher,
  })
  return {
    runtime,
    state,
    records,
    directory,
    fetcher,
    request: (path: string, init?: RequestInit) =>
      runtime.fetch(new Request(new URL(path, issuer), init)),
  }
}
describe('composed global MCP/OAuth runtime', () => {
  it('publishes exact issuer/resource, supported auth and complete catalog scopes without private calls', async () => {
    const h = harness()
    try {
      const server = await h.request('/.well-known/oauth-authorization-server')
      expect(server.status).toBe(200)
      expect(server.headers.get('cache-control')).toBe('no-store')
      expect(await server.json()).toEqual({
        issuer,
        authorization_endpoint: `${issuer}oauth/authorize`,
        token_endpoint: `${issuer}oauth/token`,
        revocation_endpoint: `${issuer}oauth/revoke`,
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
        client_id_metadata_document_supported: false,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [...supportedOAuthScopes],
      })
      const metadata = await h.request('/.well-known/oauth-protected-resource/mcp')
      expect(await metadata.json()).toMatchObject({
        resource,
        authorization_servers: [issuer],
        scopes_supported: [...supportedOAuthScopes],
      })
      expect(
        (await h.request('/mcp', { method: 'POST', body: '{}' })).headers.get('www-authenticate'),
      ).toContain(`${issuer}.well-known/oauth-protected-resource/mcp`)
      expect(h.directory.resolve).not.toHaveBeenCalled()
      expect(h.fetcher).not.toHaveBeenCalled()
    } finally {
      await h.runtime.close()
    }
  })
  it('composes explicit path-based workspace consent without changing its trusted origin or provider', async () => {
    const h = harness(30000, 'path')
    try {
      const query = new URLSearchParams({
        client_id: 'host1',
        redirect_uri: client.redirectUris[0] ?? '',
        response_type: 'code',
        resource,
        scope: 'workspace:read',
        code_challenge_method: 'S256',
        code_challenge: 'x'.repeat(43),
      })
      const started = await h.request(`/oauth/authorize?${query}`),
        handle = new URL(started.headers.get('location') ?? '').searchParams.get('federation'),
        cookie = started.headers.get('set-cookie')?.split(';')[0] ?? ''
      expect(handle).toBeTruthy()
      const selected = await h.request('/internal/oauth/browser/select', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TeamGrid-OAuth-Browser-Service-Authorization': `Bearer ${'b'.repeat(48)}`,
        },
        body: JSON.stringify({
          requestId: handle,
          cellId: 'de-test',
          workspaceId: 'team1',
          workspaceSlug: 'workspace',
        }),
      })
      expect(selected.status).toBe(200)
      const { continueUrl } = await selected.json()
      h.fetcher.mockImplementationOnce(async () =>
        Response.json({
          requestId: handle,
          cellId: 'de-test',
          region: 'de',
          clientRecordId: client._id,
        }),
      )
      const consent = await h.request(continueUrl, { headers: { Cookie: cookie } })
      expect(consent.status).toBe(303)
      const target = new URL(consent.headers.get('location') ?? '')
      expect(target.origin).toBe('https://login.example.test')
      expect(target.pathname).toBe('/workspace/developer/oauth/authorize')
      expect(target.searchParams.get('request')).toBe(handle)
      expect(target.searchParams.get('cell')).toBe('de-test')
      expect(String(h.fetcher.mock.calls[0]?.[0])).toContain(
        'https://de.example.test/internal/developer/oauth/integrations/ai-global/authorize?',
      )
      expect(h.directory.register).not.toHaveBeenCalled()
    } finally {
      await h.runtime.close()
    }
  })
  it('uses the actual registry before browser persistence and token routing', async () => {
    const h = harness()
    try {
      const query = new URLSearchParams({
        client_id: 'host1',
        redirect_uri: client.redirectUris[0] ?? '',
        response_type: 'code',
        resource,
        scope: 'workspace:read',
        code_challenge_method: 'S256',
        code_challenge: 'x'.repeat(43),
      })
      const result = await h.request(`/oauth/authorize?${query}`)
      expect(result.status).toBe(303)
      expect(h.records.size).toBe(1)
      expect(result.headers.get('set-cookie')).toContain('__Host-teamgrid-oauth-')
      expect(new URL(result.headers.get('location') ?? '').origin).toBe(
        'https://login.example.test',
      )
      h.state.revoked = true
      expect((await h.request(`/oauth/authorize?${query}`)).status).toBe(400)
      const token = await h.request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'host1',
          resource,
          grant_type: 'authorization_code',
          code: 'c'.repeat(43),
          code_verifier: 'v'.repeat(64),
          redirect_uri: client.redirectUris[0] ?? '',
        }),
      })
      expect(token.status).toBe(400)
      expect(await token.json()).toEqual({ error: 'invalid_client' })
      expect(h.records.size).toBe(1)
      expect(h.directory.resolve).not.toHaveBeenCalled()
      expect(h.fetcher).not.toHaveBeenCalled()
      expect((await h.request('/internal/oauth/browser/details', { method: 'POST' })).status).toBe(
        401,
      )
    } finally {
      await h.runtime.close()
    }
  })
  it('discovers all 208 tools through the composed runtime', async () => {
    const h = harness()
    h.directory.resolve.mockResolvedValue('de-test')
    const connection = new Client({ name: 'runtime-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: {
        headers: { Authorization: `Bearer tg_mcp_at_v1_${'x'.repeat(43)}` },
      },
      fetch: (input, init) => h.runtime.fetch(new Request(input, init)),
    })
    try {
      await connection.connect(transport)
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await connection.listTools(cursor ? { cursor } : undefined)
        names.push(...page.tools.map((tool) => tool.name))
        cursor = page.nextCursor
      } while (cursor)
      expect(names).toHaveLength(208)
      expect(new Set(names).size).toBe(208)
      const apiCalls = () =>
        h.fetcher.mock.calls.filter(([input]) =>
          (input instanceof Request ? input.url : String(input)).startsWith(
            'https://api-de.example.test/',
          ),
        ).length
      const before = apiCalls()
      expect(before).toBeGreaterThan(0)
      h.state.revoked = true
      const denied = await h.request('/mcp', {
        method: 'POST',
        body: '{}',
        headers: {
          Authorization: `Bearer tg_mcp_at_v1_${'x'.repeat(43)}`,
        },
      })
      expect(denied.status).toBe(401)
      expect(apiCalls()).toBe(before)
      h.state.revoked = false
      h.state.clientUnavailable = true
      const unavailable = await h.request('/mcp', {
        method: 'POST',
        body: '{}',
        headers: { Authorization: `Bearer tg_mcp_at_v1_${'x'.repeat(43)}` },
      })
      expect(unavailable.status).toBe(503)
      expect(unavailable.headers.has('www-authenticate')).toBe(false)
      expect(apiCalls()).toBe(before)
      expect(h.directory.resolve).toHaveBeenCalledWith(
        'access',
        createHash('sha256')
          .update(`tg_mcp_at_v1_${'x'.repeat(43)}`)
          .digest('hex'),
        expect.any(AbortSignal),
      )
    } finally {
      await connection.close()
      await h.runtime.close()
    }
  }, 20000)
  it('keeps host, feature, admission/deadline, readiness and shutdown gates', async () => {
    const h = harness(20)
    try {
      expect(
        (
          await h.runtime.fetch(
            new Request('https://evil.test/.well-known/oauth-authorization-server'),
          )
        ).status,
      ).toBe(421)
      expect((await h.request('/.well-known/oauth-authorization-server?x=1')).status).toBe(405)
      h.state.enabled = false
      expect((await h.request('/.well-known/oauth-authorization-server')).status).toBe(503)
      expect(await h.runtime.ready()).toBe(false)
      h.state.enabled = true
      h.state.admitted = false
      expect((await h.request('/.well-known/oauth-authorization-server')).status).toBe(429)
      h.state.admitted = true
      h.state.stalled = true
      expect((await h.request('/.well-known/oauth-authorization-server')).status).toBe(503)
      h.state.stalled = false
      expect(await h.runtime.ready()).toBe(true)
      await h.runtime.close()
      expect((await h.request('/.well-known/oauth-authorization-server')).status).toBe(503)
      expect(await h.runtime.ready()).toBe(false)
    } finally {
      await h.runtime.close()
    }
  })
  it('limits OAuth bytes before registry/directory work on the actual Node transport', async () => {
    const h = harness(),
      server = createFederatedMcpNodeServer(resource, h.runtime)
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve))
    const { port } = server.server.address() as AddressInfo
    const call = (length: boolean) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = nodeRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/oauth/token',
            method: 'POST',
            headers: {
              Host: 'mcp.example.test',
              'Content-Type': 'application/x-www-form-urlencoded',
              ...(length ? { 'Content-Length': '17000' } : {}),
            },
          },
          (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode))
          },
        )
        request.once('error', reject)
        request.end('x'.repeat(17000))
      })
    try {
      expect(await call(true)).toBe(413)
      expect(await call(false)).toBe(413)
      expect(h.directory.resolve).not.toHaveBeenCalled()
      expect(h.fetcher).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })
})

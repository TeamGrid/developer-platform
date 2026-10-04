import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { createFederatedMcpGateway, type FederatedMcpCell } from './federatedGateway.js'
import { responseFixture } from './fixtures.testSupport.js'
import type { ProviderResult } from './gateway.js'

const issuerUrl = 'https://mcp.example.test/'
const resourceUrl = `${issuerUrl}mcp`
const now = 1800000000000
const tokens = { de: `tg_mcp_at_v1_${'d'.repeat(43)}`, us: `tg_mcp_at_v1_${'u'.repeat(43)}` }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cells: FederatedMcpCell[] = ['de', 'us'].map((region) => ({
  region,
  cellId: `${region}-test`,
  providerUrl: `https://mcp-${region}.example.test/internal/developer/oauth/integrations/ai-global/access`,
  apiBaseUrl: `https://api-${region}.example.test/v1`,
  serviceSecret: region.repeat(24),
  apiOriginSecret: `${region}-edge-secret`,
}))
function harness(
  patch: (value: ProviderResult) => ProviderResult = (value) => value,
  timeout = 30000,
) {
  const state = {
    enabled: true,
    admitted: true,
    denied: false,
    unavailable: false,
    route: undefined as string | null | undefined,
    stalled: false,
    clientId: 'host1',
    apiCalls: 0,
    stallApiAt: Number.POSITIVE_INFINITY,
  }
  const lookups: { hash: string; signal: AbortSignal }[] = []
  const seen: { url: string; headers: Headers; body: string | undefined }[] = []
  const gateway = createFederatedMcpGateway({
    issuerUrl,
    resourceUrl,
    cells,
    now: () => now,
    requestTimeoutMs: timeout,
    toolProfile: 'full',
    writesEnabled: () => true,
    enabled: () => state.enabled,
    admitRequest: async () => state.admitted,
    resolveAccessTokenCell: async (tokenHash, signal) => {
      lookups.push({ hash: tokenHash, signal })
      if (state.stalled) return new Promise(() => {})
      if (state.unavailable) throw new Error('private directory diagnostic')
      if (state.route !== undefined) return state.route
      return tokenHash === hash(tokens.de)
        ? 'de-test'
        : tokenHash === hash(tokens.us)
          ? 'us-test'
          : null
    },
    fetch: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seen.push({ url, headers, body: init?.body as string | undefined })
      const cell = cells.find((candidate) => url === candidate.providerUrl)
      if (cell) {
        const body = JSON.parse(String(init?.body))
        if (state.denied) return Response.json({ error: 'access_denied' }, { status: 403 })
        if (body.access_token !== tokens[cell.region as 'de' | 'us']) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        // Interleave requests so a shared mutable delegation would select the wrong cell.
        await new Promise((resolve) => setTimeout(resolve, cell.region === 'de' ? 3 : 1))
        const scopes = ['workspace:read', 'projects:read', 'tasks:read', 'time-entries:read']
        return Response.json(
          patch({
            authorization: {
              active: true,
              audience: resourceUrl,
              issuer: issuerUrl,
              expiresAt: now / 1000 + 300,
              clientId: state.clientId,
              subjectId: `user-${cell.region}`,
              workspaceId: `team-${cell.region}`,
              grantId: `grant-${cell.region}`,
              region: cell.region,
              cellId: cell.cellId,
              scopes,
            },
            delegation: {
              token: `tg_oa_v2_${cell.region}_${cell.cellId}_${'b'.repeat(24)}_${'c'.repeat(64)}`,
              expiresAt: new Date(now + 300000).toISOString(),
              scopes,
              workspaceId: `team-${cell.region}`,
            },
          }),
        )
      }
      const api = cells.find((candidate) => url.startsWith(`${candidate.apiBaseUrl}/`))
      if (!api) throw new Error('Unexpected destination')
      state.apiCalls += 1
      if (state.apiCalls === state.stallApiAt) return new Promise(() => {})
      return Response.json(responseFixture('getWorkspace', `team-${api.region}`), {
        headers: { 'X-TeamGrid-Resource-CAS': 'required-v1' },
      })
    },
  })
  const request = (token = tokens.de, init: RequestInit = {}) =>
    gateway.fetch(
      new Request(resourceUrl, {
        method: 'POST',
        body: '{}',
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      }),
    )
  return { gateway, state, lookups, seen, request }
}

describe('federated OAuth MCP gateway', () => {
  it('discovers one global authority without looking up a token or contacting a cell', async () => {
    const h = harness()
    try {
      const response = await h.gateway.fetch(
        new Request(`${issuerUrl}.well-known/oauth-protected-resource/mcp`),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        resource: resourceUrl,
        authorization_servers: [issuerUrl],
      })
      expect(h.lookups).toHaveLength(0)
      expect(h.seen).toHaveLength(0)
      const missing = await h.gateway.fetch(
        new Request(resourceUrl, { method: 'POST', body: '{}' }),
      )
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp')
    } finally {
      await h.gateway.close()
    }
  })

  it('executes concurrent DE/US calls through separate verified delegations and all 208 tools', async () => {
    const h = harness()
    const clients = [
      new Client({ name: 'de', version: '1.0.0' }),
      new Client({ name: 'us', version: '1.0.0' }),
    ]
    try {
      await Promise.all(
        clients.map(async (client, index) => {
          const region = index === 0 ? 'de' : 'us'
          await client.connect(
            new StreamableHTTPClientTransport(new URL(resourceUrl), {
              requestInit: { headers: { Authorization: `Bearer ${tokens[region]}` } },
              fetch: (input, init) => h.gateway.fetch(new Request(input, init)),
            }),
          )
          let cursor: string | undefined
          const tools: string[] = []
          do {
            const page = await client.listTools(cursor ? { cursor } : {})
            tools.push(...page.tools.map((tool) => tool.name))
            cursor = page.nextCursor
          } while (cursor)
          expect(tools).toHaveLength(208)
          const result = await client.callTool({ name: 'teamgrid_workspace_get', arguments: {} })
          expect(result.isError).toBeFalsy()
          expect(JSON.stringify(result)).toContain(`team-${region}`)
          expect(JSON.stringify(result)).not.toContain(`team-${region === 'de' ? 'us' : 'de'}`)
        }),
      )
      expect(h.lookups.every((lookup) => /^[a-f0-9]{64}$/.test(lookup.hash))).toBe(true)
      for (const call of h.seen) {
        const provider = cells.find((cell) => cell.providerUrl === call.url)
        if (provider) {
          expect(call.headers.get('x-teamgrid-oauth-service-authorization')).toBe(
            `Bearer ${provider.serviceSecret}`,
          )
          expect(call.headers.has('authorization')).toBe(false)
          expect(JSON.parse(String(call.body)).access_token).toBe(
            tokens[provider.region as 'de' | 'us'],
          )
        } else {
          const api = cells.find((cell) => call.url.startsWith(`${cell.apiBaseUrl}/`))
          if (!api) throw new Error('Unexpected API destination')
          expect(call.headers.get('authorization')).toMatch(
            new RegExp(`^Bearer tg_oa_v2_${api.region}_${api.cellId}_`),
          )
          expect(call.headers.get('x-teamgrid-edge-origin-authorization')).toBe(api.apiOriginSecret)
          expect(call.body ?? '').not.toMatch(/tg_mcp_at/)
        }
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()))
      await h.gateway.close()
    }
  })

  it('never sends an unknown token to either cell and preserves the global challenge', async () => {
    const h = harness()
    try {
      const response = await h.request(`tg_mcp_at_v1_${'x'.repeat(43)}`, {
        headers: {
          Origin: new URL(resourceUrl).origin,
        },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"')
      expect(response.headers.get('access-control-allow-origin')).toBe(new URL(resourceUrl).origin)
      expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate')
      expect(h.lookups).toHaveLength(1)
      expect(h.seen).toHaveLength(0)
    } finally {
      await h.gateway.close()
    }
  })

  it.each(['directory-outage', 'unknown-cell', 'wrong-cell', 'locked-workspace'])(
    'fails closed for %s without trying another region',
    async (kind) => {
      const h = harness()
      try {
        if (kind === 'directory-outage') h.state.unavailable = true
        if (kind === 'unknown-cell') h.state.route = 'other-cell'
        if (kind === 'wrong-cell') h.state.route = 'us-test'
        if (kind === 'locked-workspace') h.state.denied = true
        const response = await h.request()
        expect(response.status).toBe(
          kind === 'wrong-cell' ? 401 : kind === 'locked-workspace' ? 403 : 503,
        )
        if (kind !== 'wrong-cell') expect(response.headers.has('www-authenticate')).toBe(false)
        expect(h.seen.length).toBeLessThanOrEqual(1)
        expect(h.seen.every((call) => call.url.includes('/internal/developer/oauth/'))).toBe(true)
        expect(JSON.stringify(await response.json())).not.toMatch(/private|tg_mcp_at/)
      } finally {
        await h.gateway.close()
      }
    },
  )

  it.each(['issuer', 'audience', 'region', 'cellId', 'workspace', 'expiry'])(
    'rejects a provider %s mismatch before any API operation',
    async (field) => {
      const h = harness((value) => {
        if (field === 'issuer') value.authorization.issuer = 'https://mcp-de.example.test/'
        if (field === 'audience') value.authorization.audience = 'https://mcp-de.example.test/mcp'
        if (field === 'region') value.authorization.region = 'us'
        if (field === 'cellId') value.authorization.cellId = 'us-test'
        if (field === 'workspace') value.delegation.workspaceId = 'another-team'
        if (field === 'expiry') value.authorization.expiresAt = now / 1000 - 1
        return value
      })
      try {
        expect((await h.request()).status).toBe(503)
        expect(h.seen).toHaveLength(1)
      } finally {
        await h.gateway.close()
      }
    },
  )

  it('checks HTTP ingress, feature gates and admission before directory lookup', async () => {
    const h = harness()
    try {
      expect((await h.request(tokens.de, { headers: { Host: 'evil.example.test' } })).status).toBe(
        421,
      )
      expect(
        (await h.request(tokens.de, { headers: { Origin: 'https://evil.example.test' } })).status,
      ).toBe(403)
      expect(
        (
          await h.gateway.fetch(
            new Request(`${resourceUrl}?access_token=${tokens.de}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${tokens.de}` },
            }),
          )
        ).status,
      ).toBe(400)
      expect((await h.request('tg_pat_v2_de_de-test_not-an-mcp-token')).status).toBe(401)
      h.state.enabled = false
      expect((await h.request()).status).toBe(503)
      h.state.enabled = true
      h.state.admitted = false
      expect((await h.request()).status).toBe(429)
      expect(h.lookups).toHaveLength(0)
      expect(h.seen).toHaveLength(0)
    } finally {
      await h.gateway.close()
    }
  })

  it('bounds an uncooperative route lookup and cancels it without forwarding the token', async () => {
    const h = harness(undefined, 15)
    h.state.stalled = true
    try {
      const response = await h.request()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'request_interrupted' })
      expect(h.lookups[0]?.signal.aborted).toBe(true)
      expect(h.seen).toHaveLength(0)
    } finally {
      await h.gateway.close()
    }
  })

  it('keeps the deadline active for a late OpenAI legacy-SSE tool call', async () => {
    const h = harness(undefined, 500)
    h.state.clientId = 'https://chatgpt.com/oauth/client.json'
    h.state.stallApiAt = 2
    try {
      const response = await h.request(tokens.de, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'teamgrid_workspace_get', arguments: {} },
        }),
      })
      expect(h.state.apiCalls).toBe(2)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'request_interrupted' })
      expect(h.lookups[0]?.signal.aborted).toBe(true)
    } finally {
      await h.gateway.close()
    }
  })

  it('rejects ambiguous cell registries and arbitrary provider paths', () => {
    const base = {
      issuerUrl,
      resourceUrl,
      enabled: () => true,
      admitRequest: async () => true,
      resolveAccessTokenCell: async () => null,
    }
    expect(() => createFederatedMcpGateway({ ...base, cells: [] })).toThrow()
    const first = cells[0]
    if (!first) throw new Error('Missing test cell')
    expect(() => createFederatedMcpGateway({ ...base, cells: [first, first] })).toThrow()
    expect(() =>
      createFederatedMcpGateway({
        ...base,
        cells: [{ ...first, issuerUrl: 'https://other.example.test/' } as FederatedMcpCell],
      }),
    ).toThrow()
    expect(() =>
      createFederatedMcpGateway({
        ...base,
        cells: [{ ...first, providerUrl: 'https://evil.example.test/arbitrary' }],
      }),
    ).toThrow()
  })
})

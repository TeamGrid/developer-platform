import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { responseFixture } from './fixtures.testSupport.js'
import {
  createRegionalMcpGateway,
  type ProviderResult,
  type RegionalMcpGatewayOptions,
} from './gateway.js'

const resourceUrl = 'https://mcp.example.test/mcp'
const issuerUrl = 'https://auth.example.test/'
const apiBaseUrl = 'https://api.de.example.test/v1'
const access = `tg_mcp_at_v1_${'a'.repeat(43)}`
const apiToken = `tg_oa_v2_de_de-test_${'b'.repeat(24)}_${'c'.repeat(64)}`
const now = 1800000000000
function harness(
  patch: (value: ProviderResult) => unknown = (value) => value,
  providerResponse?: () => Response,
  apiResponse?: (url: string) => Response,
  failingObserver = false,
) {
  const observations: Parameters<NonNullable<RegionalMcpGatewayOptions['observe']>>[0][] = []
  const seen: {
    url: string
    auth: string | null
    body: unknown
    edge: string | null
    requestId: string | null
  }[] = []
  const gateway = createRegionalMcpGateway({
    resourceUrl,
    issuerUrl,
    apiBaseUrl,
    serviceSecret: 's'.repeat(48),
    apiOriginSecret: 'edge-secret',
    region: 'de',
    cellId: 'de-test',
    now: () => now,
    enabled: () => true,
    toolProfile: 'full',
    observe: (event) => {
      observations.push(event)
      if (failingObserver) throw new Error('Isolated telemetry failure')
    },
    admitRequest: async () => true,
    fetch: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seen.push({
        url,
        auth: headers.get('authorization'),
        body: init?.body,
        edge: headers.get('x-teamgrid-edge-origin-authorization'),
        requestId: headers.get('x-request-id'),
      })
      if (url.startsWith(issuerUrl) && providerResponse) return providerResponse()
      if (url.startsWith(issuerUrl))
        return Response.json(
          patch({
            authorization: {
              active: true,
              audience: resourceUrl,
              issuer: issuerUrl,
              expiresAt: now / 1000 + 300,
              clientId: 'host',
              subjectId: 'user',
              workspaceId: 'team',
              grantId: 'grant',
              region: 'de',
              cellId: 'de-test',
              scopes: ['workspace:read'],
            },
            delegation: {
              token: apiToken,
              expiresAt: new Date(now + 300000).toISOString(),
              scopes: ['workspace:read'],
              workspaceId: 'team',
            },
          }),
        )
      if (apiResponse) return apiResponse(url)
      return Response.json(
        {
          data: { id: 'team', type: 'workspace', attributes: { name: 'Example' } },
          meta: { requestId: 'test' },
        },
        { headers: { 'X-TeamGrid-Resource-CAS': 'required-v1' } },
      )
    },
  })
  return { gateway, seen, observations }
}

describe('regional OAuth MCP gateway', () => {
  it.each(['scope', 'role'] as const)(
    'observes an HTTP 200 %s denial without logging customer data',
    async (kind) => {
      const { gateway, seen, observations } = harness(
        (value) => {
          value.authorization.clientId = 'https://chatgpt.com/oauth/client.json'
          if (kind === 'role') {
            value.authorization.scopes.push('contacts:read')
            value.delegation.scopes.push('contacts:read')
          }
          return value
        },
        undefined,
        (url) =>
          url.endsWith('/workspace')
            ? Response.json(responseFixture('getWorkspace', 'team'))
            : Response.json(
                { errors: [{ status: '403', code: 'forbidden', title: 'Forbidden' }] },
                { status: 403 },
              ),
        true,
      )
      const client = new Client({ name: 'tool-observation', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: { Authorization: `Bearer ${access}` } },
        fetch: (input, init) => gateway.fetch(new Request(input, init)),
      })
      try {
        await client.connect(transport)
        const result = await client.callTool({
          name: 'teamgrid_contact_get',
          arguments: { id: 'private-contact' },
        })
        expect(result.isError).toBe(true)
        expect(Boolean(result._meta?.['mcp/www_authenticate'])).toBe(kind === 'scope')
        const event = observations.find((event) => event.event === 'teamgrid.mcp.tool')
        expect(event).toMatchObject({
          tool: 'teamgrid_contact_get',
          isError: true,
          authChallenge: kind === 'scope',
          outcome: kind === 'scope' ? 'authorization-required' : 'failed',
          region: 'de',
          cellId: 'de-test',
        })
        expect(observations).toContainEqual(
          expect.objectContaining({
            event: 'teamgrid.mcp.request',
            requestId: event?.requestId,
            statusCode: 200,
          }),
        )
        expect(JSON.stringify(observations)).not.toMatch(/private-contact|tg_mcp_at|tg_oa_v2/)
        if (kind === 'role')
          expect(seen).toContainEqual(
            expect.objectContaining({
              requestId: event?.requestId,
              url: `${apiBaseUrl}/contacts/private-contact`,
            }),
          )
        else expect(seen.some((call) => call.url.includes('/contacts/'))).toBe(false)
      } finally {
        await client.close()
        await gateway.close()
      }
    },
  )
  it.each([401, 429, 500, 503])(
    'keeps provider status %s from becoming a new-login prompt',
    async (status) => {
      const { gateway, seen } = harness(
        undefined,
        () =>
          new Response(null, {
            status,
            headers: { 'Retry-After': '120' },
          }),
      )
      try {
        const result = await gateway.fetch(
          new Request(resourceUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}` },
          }),
        )
        expect(result.status).toBe(status === 429 ? 429 : 503)
        if (status === 429) expect(result.headers.get('retry-after')).toBe('120')
        expect(result.headers.has('www-authenticate')).toBe(false)
        expect(seen.some((call) => call.url.startsWith(apiBaseUrl))).toBe(false)
      } finally {
        await gateway.close()
      }
    },
  )
  it('reports a valid token blocked by workspace policy without reauthentication', async () => {
    const { gateway, seen } = harness(undefined, () =>
      Response.json({ error: 'access_denied' }, { status: 403 }),
    )
    try {
      const result = await gateway.fetch(
        new Request(resourceUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}` },
        }),
      )
      expect(result.status).toBe(403)
      expect(result.headers.has('www-authenticate')).toBe(false)
      expect(await result.json()).toEqual({ error: 'access_denied' })
      expect(seen.some((call) => call.url.startsWith(apiBaseUrl))).toBe(false)
    } finally {
      await gateway.close()
    }
  })

  it('challenges only an explicit invalid grant and bounds provider bodies', async () => {
    for (const [reply, status] of [
      [() => Response.json({ error: 'invalid_grant' }, { status: 400 }), 401],
      [() => new Response('x'.repeat(32769)), 503],
    ] as const) {
      const { gateway } = harness(undefined, reply)
      try {
        const result = await gateway.fetch(
          new Request(resourceUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}` },
          }),
        )
        expect(result.status).toBe(status)
      } finally {
        await gateway.close()
      }
    }
  })

  it('uses the MCP token only at its issuer and the separate delegation only at its API', async () => {
    const { gateway, seen } = harness()
    const client = new Client({ name: 'qualification', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access}` } },
      fetch: (input, init) => gateway.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    await client.close()
    const providerCalls = seen.filter((call) => call.url.startsWith(issuerUrl))
    const apiCalls = seen.filter((call) => call.url.startsWith(apiBaseUrl))
    expect(providerCalls.length).toBeGreaterThan(0)
    expect(apiCalls.length).toBeGreaterThan(0)
    for (const call of providerCalls) {
      expect(call.auth).toBe(`Bearer ${'s'.repeat(48)}`)
      expect(JSON.parse(String(call.body))).toEqual({ access_token: access })
      expect(call.edge).toBeNull()
    }
    for (const call of apiCalls) {
      expect(call.auth).toBe(`Bearer ${apiToken}`)
      expect(call.requestId).toMatch(/^mcp-[a-f0-9-]{36}$/)
      expect(providerCalls.some((provider) => provider.requestId === call.requestId)).toBe(true)
      expect(call.edge).toBe('edge-secret')
      expect(JSON.stringify(call)).not.toContain(access)
    }
  })

  it.each(['workspace', 'scopes', 'cell', 'expiry', 'issuer'])(
    'refuses a provider delegation with a mismatched %s before accessing API data',
    async (kind) => {
      const { gateway, seen } = harness((value) => {
        if (kind === 'workspace') value.delegation.workspaceId = 'other'
        if (kind === 'scopes') value.delegation.scopes.push('tasks:write')
        if (kind === 'cell') value.authorization.cellId = 'other'
        if (kind === 'expiry') value.delegation.expiresAt = new Date(now + 600000).toISOString()
        if (kind === 'issuer') value.authorization.issuer = 'https://other.example.test/'
        return value
      })
      const response = await gateway.fetch(
        new Request(resourceUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: '{}',
        }),
      )
      expect(response.status).toBe(503)
      expect(seen.some((call) => call.url.startsWith(apiBaseUrl))).toBe(false)
    },
  )

  it('rejects PATs and shared API credentials at the MCP authorization boundary', async () => {
    const { gateway, seen } = harness()
    const response = await gateway.fetch(
      new Request(resourceUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}` },
      }),
    )
    expect(response.status).toBe(401)
    expect(seen).toEqual([])
  })
})

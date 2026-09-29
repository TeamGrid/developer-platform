import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { createTeamGridMcpHttpHandler, type McpAuthorization, type McpHttpOptions } from './http.js'

const resourceUrl = 'https://mcp.de.example.test/mcp'
const issuerUrl = 'https://auth.de.example.test/'
const now = 1790000000000
const grant = (workspaceId = 'workspace-a'): McpAuthorization => ({
  active: true,
  audience: resourceUrl,
  issuer: issuerUrl,
  clientId: 'test-client',
  subjectId: 'user-1',
  grantId: 'grant-1',
  workspaceId,
  region: 'de',
  cellId: 'de-nbg-001',
  scopes: ['workspace:read'],
  expiresAt: now / 1000 + 600,
})
function setup(overrides: Partial<McpHttpOptions> = {}) {
  const createDelegatedClient = vi.fn(
    async (authorization: McpAuthorization) =>
      ({
        workspace: {
          get: async () => ({
            data: { id: authorization.workspaceId, type: 'workspace' },
            meta: {},
          }),
        },
        tasks: { create: vi.fn(async () => ({ data: { id: 'task-1' }, meta: {} })) },
      }) as never,
  )
  const verifyAccessToken = vi.fn(async () => grant())
  const options = {
    resourceUrl,
    issuerUrl,
    region: 'de',
    cellId: 'de-nbg-001',
    enabled: () => true,
    admitRequest: async () => true,
    createDelegatedClient,
    verifyAccessToken,
    now: () => now,
    ...overrides,
  }
  return {
    handler: createTeamGridMcpHttpHandler(options),
    createDelegatedClient,
    verifyAccessToken: options.verifyAccessToken,
  }
}
function request(token?: string, url = resourceUrl, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

describe('regional HTTP MCP authorization boundary', () => {
  it('publishes resource metadata and challenges missing authorization', async () => {
    const { handler, createDelegatedClient } = setup()
    try {
      const unauthorized = await handler.fetch(request())
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.headers.get('www-authenticate')).toContain(
        '/.well-known/oauth-protected-resource/mcp',
      )
      const metadata = await handler.fetch(
        new Request('https://mcp.de.example.test/.well-known/oauth-protected-resource/mcp'),
      )
      expect(await metadata.json()).toMatchObject({
        resource: resourceUrl,
        authorization_servers: [issuerUrl],
        bearer_methods_supported: ['header'],
      })
      expect(createDelegatedClient).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })

  it.each([
    { active: false },
    { audience: 'https://other.example.test/mcp' },
    { issuer: 'https://other.example.test/' },
    { region: 'us' },
    { cellId: 'us-mnz-001' },
    { expiresAt: now / 1000 },
  ])('rejects invalid grant %j before any API client is created', async (override) => {
    const { handler, createDelegatedClient } = setup({
      verifyAccessToken: async () => ({ ...grant(), ...override }),
    })
    try {
      expect((await handler.fetch(request('opaque-access-token'))).status).toBe(401)
      expect(createDelegatedClient).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })

  it('rejects API tokens, query tokens, wrong host and unapproved origins', async () => {
    const { handler, verifyAccessToken } = setup()
    try {
      expect((await handler.fetch(request('tg_pat_v2_not-a-real-token'))).status).toBe(401)
      expect(
        (await handler.fetch(request(undefined, `${resourceUrl}?access_token=not-a-real-token`)))
          .status,
      ).toBe(400)
      expect(
        (await handler.fetch(request('opaque', 'https://attacker.example.test/mcp'))).status,
      ).toBe(421)
      expect(
        (
          await handler.fetch(
            request('opaque', resourceUrl, { Origin: 'https://attacker.example.test' }),
          )
        ).status,
      ).toBe(403)
      expect(verifyAccessToken).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })

  it('distinguishes verifier outages from revoked credentials without leaking errors', async () => {
    const { handler } = setup({
      verifyAccessToken: async () => {
        throw new Error('secret-provider-detail')
      },
    })
    try {
      const response = await handler.fetch(request('opaque'))
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('secret-provider-detail')
    } finally {
      await handler.close()
    }
  })

  it.each(['disabled', 'limited'] as const)('closes %s before verifying tokens', async (state) => {
    const { handler, verifyAccessToken } = setup({
      enabled: () => state !== 'disabled',
      admitRequest: async () => state !== 'limited',
    })
    try {
      expect((await handler.fetch(request('opaque'))).status).toBe(state === 'disabled' ? 503 : 429)
      expect(verifyAccessToken).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })

  it('requires workspace scope with an OAuth scope challenge', async () => {
    const { handler } = setup({
      verifyAccessToken: async () => ({ ...grant(), scopes: ['tasks:read'] }),
    })
    try {
      const response = await handler.fetch(request('opaque'))
      expect(response.status).toBe(403)
      expect(response.headers.get('www-authenticate')).toContain('scope="workspace:read"')
    } finally {
      await handler.close()
    }
  })

  it('bounds request bodies before delegation and rejects a misbound API workspace', async () => {
    const client = {
      workspace: { get: async () => ({ data: { id: 'foreign-workspace' }, meta: {} }) },
    }
    const { handler, createDelegatedClient } = setup({
      createDelegatedClient: vi.fn(async () => client as never),
    })
    try {
      const large = new Request(resourceUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer opaque', 'Content-Type': 'application/json' },
        body: ' '.repeat(256 * 1024 + 1),
      })
      expect((await handler.fetch(large)).status).toBe(413)
      expect(createDelegatedClient).not.toHaveBeenCalled()
      const wrong = await handler.fetch(
        request('opaque', resourceUrl, { Accept: 'application/json, text/event-stream' }),
      )
      const body = await wrong.text()
      expect(body).not.toContain('foreign-workspace')
      expect(body).not.toContain('teamgrid_workspace_get')
    } finally {
      await handler.close()
    }
  })

  it.each(['work', 'full', 'tasks-write'] as const)(
    'returns the full required scope set before executing a write in %s',
    async (toolProfile) => {
      const { handler } = setup({ toolProfile, writesEnabled: () => true })
      try {
        const response = await handler.fetch(
          new Request(resourceUrl, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer opaque',
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'teamgrid_task_create',
                arguments: {
                  workspaceId: 'workspace-a',
                  idempotencyKey: 'intent-1',
                  data: { name: 'Task' },
                },
              },
            }),
          }),
        )
        expect(response.status).toBe(403)
        expect(response.headers.get('www-authenticate')).toContain('tasks:write')
        expect(response.headers.get('www-authenticate')).toContain('workspace:read')
      } finally {
        await handler.close()
      }
    },
  )

  it.each([
    ['work', 34],
    ['full', 84],
    ['time-write', 3],
  ] as const)(
    'serves %s reads with writes disabled, isolated delegation and fresh revocation checks',
    async (toolProfile, readCount) => {
      let revoked = false
      const { handler, createDelegatedClient, verifyAccessToken } = setup({
        verifyAccessToken: vi.fn(async (token) =>
          revoked ? null : grant(token === 'token-a' ? 'workspace-a' : 'workspace-b'),
        ),
        toolProfile,
        writesEnabled: () => false,
      })
      const clients = ['token-a', 'token-b'].map((token) => ({
        client: new Client(
          { name: 'http-test', version: '1.0.0' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } },
        ),
        transport: new StreamableHTTPClientTransport(new URL(resourceUrl), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: (input, init) => handler.fetch(new Request(input, init)),
        }),
      }))
      try {
        await Promise.all(clients.map(({ client, transport }) => client.connect(transport)))
        const responses = await Promise.all(
          clients.map(({ client }) =>
            client.callTool({ name: 'teamgrid_workspace_get', arguments: {} }),
          ),
        )
        expect(responses.map((r) => r.structuredContent)).toEqual([
          { data: { id: 'workspace-a', type: 'workspace' }, meta: {} },
          { data: { id: 'workspace-b', type: 'workspace' }, meta: {} },
        ])
        const tools = await clients[0]?.client.listTools()
        expect(tools?.tools).toHaveLength(readCount)
        expect(tools?.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
        expect(
          createDelegatedClient.mock.calls.every(([authorization]) => !('token' in authorization)),
        ).toBe(true)
        revoked = true
        await expect(
          clients[0]?.client.callTool({ name: 'teamgrid_workspace_get', arguments: {} }),
        ).rejects.toThrow()
        expect(verifyAccessToken).toHaveBeenCalled()
      } finally {
        await Promise.allSettled(clients.map(({ client }) => client.close()))
        await handler.close()
      }
    },
  )
})

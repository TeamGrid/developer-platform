import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { TeamGridApiError } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { domainToolNames } from './domainTools.js'
import { responseFixture } from './fixtures.testSupport.js'
import { createTeamGridMcpHttpHandler, type McpAuthorization } from './http.js'
import { toolScopes } from './toolScopes.js'

const resourceUrl = 'https://mcp.de.example.test/mcp'
const issuerUrl = 'https://auth.de.example.test/'
const chatGptClient = 'https://chatgpt.com/oauth/client.json'

const appointmentIntent = {
  name: 'teamgrid_appointment_create',
  arguments: {
    workspaceId: 'workspace-a',
    idempotencyKey: 'delegated-intent',
    data: {
      userId: 'user-2',
      start: { at: '2026-10-05T09:00:00Z' },
      end: { at: '2026-10-05T10:00:00Z' },
    },
  },
}

function scopeRefusal(scope = 'appointments:delegated:write') {
  return new TeamGridApiError({
    status: 403,
    errors: [{ code: 'insufficient_scope', status: '403', title: 'Forbidden', detail: 'Denied.' }],
    transport: {
      status: 403,
      attempts: 1,
      requestId: 'scope-refusal',
      rateLimit: {},
      headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
    },
  })
}

function setup(clientId = chatGptClient, registerHost = false) {
  let current: McpAuthorization | null = {
    active: true,
    audience: resourceUrl,
    issuer: issuerUrl,
    clientId,
    subjectId: 'user-1',
    grantId: 'grant-1',
    workspaceId: 'workspace-a',
    region: 'de',
    cellId: 'de-nbg-001',
    scopes: ['workspace:read'],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  }
  const create = vi.fn(async () => responseFixture('createTask', 'task-1'))
  const list = vi.fn(async () => {
    throw new TeamGridApiError({ status: 403 })
  })
  const productCreate = vi.fn(async () => responseFixture('createProduct', 'product-1'))
  const appointmentCreate = vi.fn(async () => responseFixture('createAppointment', 'appointment-1'))
  const client = {
    workspace: {
      get: async () => ({
        ...responseFixture('getWorkspace', 'workspace-a'),
        transport: { headers: { 'x-teamgrid-resource-cas': 'required-v1' } },
      }),
    },
    tasks: { create, list },
    products: { create: productCreate },
    appointments: { create: appointmentCreate },
  }
  const createDelegatedClient = vi.fn(async () => client as never)
  const handler = createTeamGridMcpHttpHandler({
    resourceUrl,
    issuerUrl,
    region: 'de',
    cellId: 'de-nbg-001',
    toolProfile: 'full',
    hostClients: registerHost ? [{ clientId, host: 'anthropic' }] : [],
    enabled: () => true,
    writesEnabled: () => true,
    admitRequest: async () => true,
    verifyAccessToken: async () => current,
    createDelegatedClient,
  })
  let requestId = 0
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await handler.fetch(
      new Request(resourceUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-access',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      }),
    )
    const body = await response.text()
    const json = response.headers.get('content-type')?.includes('text/event-stream')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6)
      : body
    return { response, message: JSON.parse(json || '{}') }
  }
  return {
    handler,
    rpc,
    create,
    list,
    productCreate,
    appointmentCreate,
    createDelegatedClient,
    update: (changes: Partial<McpAuthorization>) => {
      if (current) current = { ...current, ...changes }
    },
    revoke: () => {
      current = null
    },
  }
}

describe('ChatGPT OAuth permission escalation', () => {
  it.each(['2025-11-25', '2026-07-28'] as const)(
    'returns late API scope challenges over HTTP to an actual %s standard client',
    async (version) => {
      const test = setup('standard-client')
      test.update({ scopes: ['workspace:read', 'appointments:write'] })
      test.appointmentCreate.mockImplementationOnce(async () => {
        throw scopeRefusal()
      })
      const client = new Client(
        { name: 'standard-fixture', version: '1.0.0' },
        {
          versionNegotiation: { mode: version === '2025-11-25' ? 'legacy' : { pin: version } },
        },
      )
      let lastResponse: Response | undefined
      const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-access' } },
        fetch: async (input, init) => {
          lastResponse = await test.handler.fetch(new Request(input, init))
          return lastResponse
        },
      })
      try {
        await client.connect(transport)
        await expect(client.callTool(appointmentIntent)).rejects.toThrow()
        expect(lastResponse?.status).toBe(403)
        expect(lastResponse?.headers.get('www-authenticate')).toContain(
          'appointments:delegated:write',
        )
        expect(test.appointmentCreate).toHaveBeenCalledOnce()
        test.update({
          scopes: ['workspace:read', 'appointments:write', 'appointments:delegated:write'],
        })
        const approved = await client.callTool(appointmentIntent)
        expect(approved.isError).not.toBe(true)
        expect(test.appointmentCreate).toHaveBeenCalledTimes(2)
      } finally {
        await client.close()
        await test.handler.close()
      }
    },
  )

  it('isolates a delayed HTTP scope refusal from a concurrent successful request', async () => {
    const test = setup('standard-client')
    test.update({ scopes: ['workspace:read', 'appointments:write'] })
    let started: () => void = () => {}
    let release: () => void = () => {}
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    test.appointmentCreate.mockImplementationOnce(async () => {
      started()
      await gate
      throw scopeRefusal()
    })
    try {
      const pending = test.rpc('tools/call', appointmentIntent)
      await began
      const read = await test.rpc('tools/call', { name: 'teamgrid_workspace_get', arguments: {} })
      expect(read.response.status).toBe(200)
      expect(read.response.headers.has('www-authenticate')).toBe(false)
      expect(read.message.result.structuredContent.data.id).toBe('workspace-a')
      release()
      const denied = await pending
      expect(denied.response.status).toBe(403)
      expect(denied.response.headers.get('www-authenticate')).toContain(
        'appointments:delegated:write',
      )
    } finally {
      release()
      await test.handler.close()
    }
  })

  it.each([chatGptClient, 'standard-client'])(
    'keeps role, sharing and unrecognized scope errors out of consent for %s',
    async (clientId) => {
      const test = setup(clientId)
      test.update({ scopes: ['workspace:read', 'appointments:write'] })
      try {
        for (const failure of [
          new TeamGridApiError({ status: 403 }),
          scopeRefusal('credentials:write'),
        ]) {
          test.appointmentCreate.mockImplementationOnce(async () => {
            throw failure
          })
          const denied = await test.rpc('tools/call', appointmentIntent)
          expect(denied.response.status).toBe(200)
          expect(denied.message.result.isError).toBe(true)
          expect(denied.response.headers.has('www-authenticate')).toBe(false)
          expect(denied.message.result._meta?.['mcp/www_authenticate']).toBeUndefined()
        }
      } finally {
        await test.handler.close()
      }
    },
  )

  it.each([
    ['https://claude.ai/oauth/claude-code-client-metadata', false],
    ['https://claude.ai/oauth/mcp-oauth-client-metadata', false],
    ['operator-registered-claude', true],
  ] as const)(
    'keeps all 208 tools and requests confirmation for every Claude write: %s',
    async (id, registered) => {
      const test = setup(id, registered)
      try {
        const tools = []
        let cursor: string | undefined
        do {
          const { message } = await test.rpc('tools/list', cursor ? { cursor } : {})
          tools.push(...message.result.tools)
          cursor = message.result.nextCursor
        } while (cursor)
        expect(tools).toHaveLength(208)
        expect(tools.filter((tool) => tool.annotations.readOnlyHint)).toHaveLength(83)
        for (const tool of tools)
          expect(tool.annotations.destructiveHint).toBe(!tool.annotations.readOnlyHint)
        // Scopes and the core create semantics remain unchanged by presentation.
        expect(
          tools.find((tool) => tool.name === 'teamgrid_task_create').securitySchemes[0].scopes,
        ).toEqual(['tasks:write', 'workspace:read'])
      } finally {
        await test.handler.close()
      }
    },
  )

  it.each([chatGptClient, 'claude-fixture', 'microsoft-fixture'])(
    'presents API-derived delegated scopes correctly for %s and preserves the intent',
    async (clientId) => {
      const test = setup(clientId)
      const scopes = ['workspace:read', 'appointments:write', 'tasks:read']
      test.update({ scopes })
      test.appointmentCreate.mockImplementationOnce(async () => {
        throw new TeamGridApiError({
          status: 403,
          errors: [
            { code: 'insufficient_scope', status: '403', title: 'Forbidden', detail: 'Denied.' },
          ],
          transport: {
            status: 403,
            attempts: 1,
            requestId: 'scope-refusal',
            headers: {
              'www-authenticate':
                'Bearer error="insufficient_scope", scope="appointments:delegated:write"',
            },
            rateLimit: {},
          },
        })
      })
      const params = {
        name: 'teamgrid_appointment_create',
        arguments: {
          workspaceId: 'workspace-a',
          idempotencyKey: 'delegated-intent',
          data: {
            userId: 'user-2',
            start: { at: '2026-10-05T09:00:00Z' },
            end: { at: '2026-10-05T10:00:00Z' },
          },
        },
      }
      try {
        const denied = await test.rpc('tools/call', params)
        const challenge =
          clientId === chatGptClient
            ? denied.message.result._meta['mcp/www_authenticate'][0]
            : denied.response.headers.get('www-authenticate')
        expect(denied.response.status).toBe(clientId === chatGptClient ? 200 : 403)
        expect(challenge).toContain(
          'scope="appointments:delegated:write appointments:write tasks:read workspace:read"',
        )
        expect(challenge).toContain(
          'resource_metadata="https://mcp.de.example.test/.well-known/oauth-protected-resource/mcp"',
        )
        expect(test.appointmentCreate).toHaveBeenCalledOnce()
        // The API refused before mutation. Only separately approved rights can retry.
        test.update({ scopes: [...scopes, 'appointments:delegated:write'] })
        const approved = await test.rpc('tools/call', params)
        expect(approved.response.status).toBe(200)
        expect(approved.message.result.isError).not.toBe(true)
        expect(test.appointmentCreate).toHaveBeenCalledTimes(2)
        expect(test.appointmentCreate.mock.calls[1]).toEqual(test.appointmentCreate.mock.calls[0])
      } finally {
        await test.handler.close()
      }
    },
  )

  it('keeps previous permissions in standard HTTP preflight challenges', async () => {
    const test = setup('standard-client')
    test.update({ scopes: ['workspace:read', 'projects:read'] })
    try {
      const denied = await test.rpc('tools/call', { name: 'teamgrid_tasks_list', arguments: {} })
      expect(denied.response.status).toBe(403)
      expect(denied.response.headers.get('www-authenticate')).toContain(
        'scope="projects:read tasks:read workspace:read"',
      )
      expect(test.list).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })

  it('publishes every tool auth policy and its compatibility mirror through bounded discovery', async () => {
    const test = setup()
    try {
      const tools = []
      let cursor: string | undefined
      do {
        const { response, message } = await test.rpc('tools/list', cursor ? { cursor } : {})
        expect(response.status).toBe(200)
        expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(256 * 1024)
        expect(message.result.tools.length).toBeLessThanOrEqual(50)
        tools.push(...message.result.tools)
        cursor = message.result.nextCursor
      } while (cursor)
      expect(tools.map((tool) => tool.name).sort()).toEqual([...domainToolNames].sort())
      for (const tool of tools) {
        // OpenAI requires these safety hints on the actual descriptor. Private
        // workspace reads are closed-world, even for stored external targets.
        expect(tool.annotations).toMatchObject({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        })
        if (tool.annotations.readOnlyHint) {
          expect(tool.annotations.destructiveHint).toBe(false)
          expect(tool.annotations.openWorldHint).toBe(false)
          expect(tool.description).not.toContain('May notify other people.')
        }
        expect(tool.securitySchemes).toHaveLength(1)
        expect(tool.securitySchemes[0].type).toBe('oauth2')
        for (const scope of toolScopes[tool.name as keyof typeof toolScopes])
          expect(tool.securitySchemes[0].scopes).toContain(scope)
        expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes)
        expect(tool.securitySchemes[0].scopes).toContain('workspace:read')
      }
      expect(tools.find((tool) => tool.name === 'teamgrid_task_create').securitySchemes).toEqual([
        { type: 'oauth2', scopes: ['tasks:write', 'workspace:read'] },
      ])
      expect(
        tools.find((tool) => tool.name === 'teamgrid_tasks_list').securitySchemes[0].scopes,
      ).toContain('tasks:read')
      // Outbound mutations retain their safety declaration after read metadata
      // is corrected; annotations never replace authorization or user consent.
      for (const name of [
        'teamgrid_webhook_delivery_test',
        'teamgrid_invitation_create',
        'teamgrid_automation_definition_create',
      ]) {
        expect(tools.find((tool) => tool.name === name).annotations).toMatchObject({
          readOnlyHint: false,
          openWorldHint: true,
        })
      }
    } finally {
      await test.handler.close()
    }
  })

  it.each(['2025-11-25', '2026-07-28'] as const)(
    'delivers the consent signal to an actual %s MCP client',
    async (version) => {
      const test = setup()
      const client = new Client(
        { name: 'protocol-fixture', version: '1.0.0' },
        {
          versionNegotiation: { mode: version === '2025-11-25' ? 'legacy' : { pin: version } },
        },
      )
      const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-access' } },
        fetch: (input, init) => test.handler.fetch(new Request(input, init)),
      })
      try {
        await client.connect(transport)
        const denied = await client.callTool({ name: 'teamgrid_tasks_list', arguments: {} })
        expect(denied.isError).toBe(true)
        expect(denied._meta?.['mcp/www_authenticate']).toEqual([
          expect.stringContaining('scope="tasks:read workspace:read"'),
        ])
        expect(test.list).not.toHaveBeenCalled()
        const read = await client.callTool({ name: 'teamgrid_workspace_get', arguments: {} })
        expect(read.isError).not.toBe(true)
      } finally {
        await client.close()
        await test.handler.close()
      }
    },
  )

  it.each([chatGptClient, 'https://chatgpt.com/oauth/callback_123/client.json', 'test-client'])(
    'refuses a foreign workspace before asking for scopes for %s',
    async (clientId) => {
      const test = setup(clientId)
      try {
        const denied = await test.rpc('tools/call', {
          name: 'teamgrid_task_create',
          arguments: {
            workspaceId: 'foreign-workspace',
            idempotencyKey: 'intent',
            data: { name: 'Test' },
          },
        })
        expect(denied.response.status).toBe(200)
        expect(denied.message.result.isError).toBe(true)
        expect(denied.message.result._meta?.['mcp/www_authenticate']).toBeUndefined()
        expect(JSON.stringify(denied.message)).toContain('workspace_mismatch')
        expect(test.create).not.toHaveBeenCalled()
      } finally {
        await test.handler.close()
      }
    },
  )

  it('supports the documented callback-specific ChatGPT identity', async () => {
    const test = setup('https://chatgpt.com/oauth/callback_123/client.json')
    try {
      const denied = await test.rpc('tools/call', { name: 'teamgrid_tasks_list', arguments: {} })
      expect(denied.response.status).toBe(200)
      expect(denied.message.result._meta['mcp/www_authenticate'][0]).toContain('tasks:read')
    } finally {
      await test.handler.close()
    }
  })

  it('preserves the explicit workspace boundary after the user approves write scopes', async () => {
    const test = setup()
    test.update({ scopes: ['workspace:read', 'tasks:write'] })
    try {
      const denied = await test.rpc('tools/call', {
        name: 'teamgrid_task_create',
        arguments: {
          workspaceId: 'foreign-workspace',
          idempotencyKey: 'wrong-workspace',
          data: { name: 'Test' },
        },
      })
      expect(denied.message.result.isError).toBe(true)
      expect(JSON.stringify(denied.message.result)).toContain('workspace_mismatch')
      expect(denied.message.result._meta?.['mcp/www_authenticate']).toBeUndefined()
      expect(test.create).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })

  it('asks for additional consent without writing or breaking an active workspace-only connection', async () => {
    const test = setup()
    const params = {
      name: 'teamgrid_task_create',
      arguments: {
        workspaceId: 'workspace-a',
        idempotencyKey: 'intent-1',
        data: { name: 'Test' },
      },
    }
    try {
      const denied = await test.rpc('tools/call', params)
      expect(denied.response.status).toBe(200)
      expect(denied.message.result.isError).toBe(true)
      const challenges = denied.message.result._meta['mcp/www_authenticate']
      expect(challenges).toHaveLength(1)
      expect(challenges[0]).toContain('error="insufficient_scope"')
      expect(challenges[0]).toContain('error_description=')
      expect(challenges[0]).toContain('scope="tasks:write workspace:read"')
      expect(challenges[0]).toContain(
        `resource_metadata="https://mcp.de.example.test/.well-known/oauth-protected-resource/mcp"`,
      )
      expect(test.create).not.toHaveBeenCalled()
      const read = await test.rpc('tools/call', { name: 'teamgrid_workspace_get', arguments: {} })
      expect(read.message.result.structuredContent.data.id).toBe('workspace-a')
      // A refreshed token with the same scopes still cannot write.
      test.update({ expiresAt: Math.floor(Date.now() / 1000) + 300 })
      expect((await test.rpc('tools/call', params)).message.result.isError).toBe(true)
      expect(test.create).not.toHaveBeenCalled()
      // A separately approved grant can execute the same intent once.
      test.update({ grantId: 'approved-grant', scopes: ['workspace:read', 'tasks:write'] })
      const approved = await test.rpc('tools/call', params)
      expect(approved.message.result.isError).not.toBe(true)
      expect(approved.message.result.structuredContent.data.id).toBe('task-1')
      expect(test.create).toHaveBeenCalledOnce()
    } finally {
      await test.handler.close()
    }
  })

  it('includes argument-dependent finance consent and keeps existing approved scopes', async () => {
    const test = setup()
    test.update({ scopes: ['workspace:read', 'products:write', 'tasks:read'] })
    try {
      const denied = await test.rpc('tools/call', {
        name: 'teamgrid_product_create',
        arguments: {
          workspaceId: 'workspace-a',
          idempotencyKey: 'finance-intent',
          data: { name: 'Product', purchasePrice: 12 },
        },
      })
      expect(denied.message.result._meta['mcp/www_authenticate'][0]).toContain(
        'scope="products:finance:write products:write tasks:read workspace:read"',
      )
      expect(test.productCreate).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })

  it('does not turn role or sharing denial into broader OAuth consent', async () => {
    const test = setup()
    test.update({ scopes: ['workspace:read', 'tasks:read'] })
    try {
      const denied = await test.rpc('tools/call', { name: 'teamgrid_tasks_list', arguments: {} })
      expect(denied.message.result.isError).toBe(true)
      expect(denied.message.result._meta?.['mcp/www_authenticate']).toBeUndefined()
      expect(test.list).toHaveBeenCalledOnce()
    } finally {
      await test.handler.close()
    }
  })

  it.each([
    'test-client',
    'https://chatgpt.com.evil.test/oauth/client.json',
    'https://chatgpt.com/oauth/client.json?hint=chatgpt',
  ])('keeps standard HTTP scope challenges for verified client %s', async (clientId) => {
    const test = setup(clientId)
    try {
      const denied = await test.rpc('tools/call', {
        name: 'teamgrid_task_create',
        arguments: {
          workspaceId: 'workspace-a',
          idempotencyKey: 'intent-1',
          data: { name: 'Test' },
        },
      })
      expect(denied.response.status).toBe(403)
      expect(denied.response.headers.get('www-authenticate')).toContain('tasks:write')
      expect(test.create).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })

  it.each([
    { expiresAt: 1 },
    { audience: 'https://foreign.test/mcp' },
    { region: 'us' },
    { cellId: 'us-mnz-001' },
  ])('rejects an invalid ChatGPT token before delegation: %j', async (changes) => {
    const test = setup()
    test.update(changes)
    try {
      const denied = await test.rpc('tools/list')
      expect(denied.response.status).toBe(401)
      expect(test.createDelegatedClient).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })

  it('keeps revocation effective immediately for ChatGPT', async () => {
    const test = setup()
    test.revoke()
    try {
      expect((await test.rpc('tools/list')).response.status).toBe(401)
      expect(test.createDelegatedClient).not.toHaveBeenCalled()
    } finally {
      await test.handler.close()
    }
  })
})

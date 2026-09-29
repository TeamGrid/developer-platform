import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { describe, expect, it } from 'vitest'
import { createTeamGridMcpServer } from './server.js'

describe('MCP wire protocol compatibility', () => {
  it.each(['modern', 'legacy'] as const)(
    'serves discovery, tool calls and errors for %s clients',
    async (era) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = serveStdio(
        () =>
          createTeamGridMcpServer({
            workspace: {
              get: async () => ({ data: { id: 'workspace-1', type: 'workspace' }, meta: {} }),
            },
          } as never),
        { transport: serverTransport },
      )
      const client =
        era === 'modern'
          ? new Client(
              { name: 'modern', version: '1.0.0' },
              { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            )
          : new LegacyClient({ name: 'legacy', version: '1.0.0' })
      try {
        await client.connect(clientTransport)
        if (client instanceof Client) expect(client.getProtocolEra()).toBe('modern')
        expect((await client.listTools()).tools).toHaveLength(22)
        const result = await client.callTool({ name: 'teamgrid_workspace_get', arguments: {} })
        expect(result.structuredContent).toMatchObject({ data: { id: 'workspace-1' } })
        await expect(
          client.callTool({ name: 'teamgrid_task_create', arguments: {} }),
        ).rejects.toThrow('disabled')
      } finally {
        await client.close()
        await server.close()
      }
    },
  )
})

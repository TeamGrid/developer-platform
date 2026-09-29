import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { privateResourceUri } from './fileResources.js'
import { createTeamGridMcpServer } from './server.js'

describe('private MCP resource delivery', () => {
  it('delivers export bytes, redacts transfer credentials and rechecks each read', async () => {
    const api = {
      exports: {
        createDownloadIntent: vi.fn(async () => ({
          data: { attributes: { token: 'private-intent-canary' } },
        })),
        download: vi.fn(async () => ({
          data: new TextEncoder().encode('name\nExample\n'),
          contentType: 'text/csv',
        })),
        get: vi.fn(async () => ({})),
      },
    }
    const server = createTeamGridMcpServer(api as never, { toolProfile: 'full' })
    const client = new Client({ name: 'private-resource-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(a), client.connect(b)])
      const templates = await client.listResourceTemplates()
      expect(templates.resourceTemplates.map((item) => item.uriTemplate)).toContain(
        'teamgrid://exports/{id}',
      )
      const result = await client.readResource({ uri: privateResourceUri('exports', 'job1') })
      expect(result.contents[0]).toMatchObject({
        mimeType: 'text/csv',
        blob: Buffer.from('name\nExample\n').toString('base64'),
      })
      expect(JSON.stringify(result)).not.toContain('private-intent-canary')
      expect(api.exports.download).toHaveBeenCalledWith(
        'job1',
        expect.objectContaining({ intentToken: 'private-intent-canary', maxBytes: 1048576 }),
      )
      api.exports.get.mockRejectedValueOnce(new Error('private-intent-canary'))
      await expect(
        client.readResource({ uri: privateResourceUri('exports', 'job1') }),
      ).rejects.not.toThrow('private-intent-canary')
      expect(api.exports.createDownloadIntent).toHaveBeenCalledTimes(2)
    } finally {
      await client.close()
      await server.close()
    }
  })
  it('does not expose resource templates when their corresponding tools are disabled', async () => {
    const server = createTeamGridMcpServer({} as never, {
      toolProfile: 'context',
      denyTools: ['teamgrid_file_get'],
    })
    const client = new Client({ name: 'private-resource-profile-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(a), client.connect(b)])
      expect(client.getServerCapabilities()?.resources).toBeUndefined()
      await expect(client.readResource({ uri: 'teamgrid://files/file1' })).rejects.toThrow()
    } finally {
      await client.close()
      await server.close()
    }
    expect(() => privateResourceUri('files', '../foreign')).toThrow()
  })
})

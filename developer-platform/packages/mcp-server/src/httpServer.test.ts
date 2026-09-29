import { request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createMcpNodeServer } from './httpServer.js'

describe('hosted MCP Node transport', () => {
  it('preserves canonical routing and bytes, rejects alternate authorities, and closes cleanly', async () => {
    const handler = {
      fetch: vi.fn(async (request: Request) =>
        Response.json({
          url: request.url,
          body: await request.text(),
        }),
      ),
      close: vi.fn(async () => {}),
    }
    let ready = false
    const runtime = createMcpNodeServer('https://mcp.example.test/mcp', handler, {
      ready: async () => ready,
    })
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve))
    const { port } = runtime.server.address() as AddressInfo
    const call = (path: string, host = 'mcp.example.test', method = 'POST') =>
      new Promise<{
        status: number | undefined
        text: string
      }>((resolve, reject) => {
        const request = nodeRequest(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: { Host: host, 'Content-Type': 'application/json' },
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () =>
              resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }),
            )
          },
        )
        request.once('error', reject)
        request.end(method === 'POST' ? '{"jsonrpc":"2.0"}' : undefined)
      })
    try {
      const response = await call('/mcp')
      expect(response.status).toBe(200)
      expect(JSON.parse(response.text)).toEqual({
        url: 'https://mcp.example.test/mcp',
        body: '{"jsonrpc":"2.0"}',
      })
      expect((await call('/mcp', 'evil.example')).status).toBe(421)
      expect((await call('//evil.example/mcp')).status).toBe(400)
      expect((await call('https://evil.example/mcp')).status).toBe(400)
      expect((await call('/healthz', '127.0.0.1', 'GET')).status).toBe(200)
      expect((await call('/readyz', 'mcp.example.test', 'GET')).status).toBe(503)
      ready = true
      expect((await call('/readyz', 'mcp.example.test', 'GET')).status).toBe(200)
      expect((await call('/readyz', 'foreign.example', 'GET')).status).toBe(421)
      expect(handler.fetch).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.close()
    }
    expect(handler.close).toHaveBeenCalledOnce()
  })
})

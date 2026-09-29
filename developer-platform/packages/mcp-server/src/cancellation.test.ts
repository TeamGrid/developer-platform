import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { TeamGridClient } from '@teamgrid/api-client'
import { expect, it, vi } from 'vitest'
import { createTeamGridMcpServer } from './server.js'

it('cancels an in-flight API body from MCP and keeps correlation isolated across calls', async () => {
  // gitleaks:allow -- synthetic credential, no network.
  const token = `tg_sk_v1_us_us-mnz-001_${'a'.repeat(24)}_${'b'.repeat(64)}`
  const calls: { signal?: AbortSignal | null; id: string | null }[] = []
  const cancel = vi.fn()
  const api = new TeamGridClient({
    token,
    fetch: async (_input, init) => {
      calls.push({ signal: init?.signal, id: new Headers(init?.headers).get('x-request-id') })
      return new Response(new ReadableStream({ cancel }))
    },
  })
  const server = createTeamGridMcpServer(api)
  const client = new Client({ name: 'cancellation-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const controllers = [new AbortController(), new AbortController()]
  try {
    const results = controllers.map((controller) =>
      client.callTool({ name: 'teamgrid_tasks_list', arguments: {} }, undefined, {
        signal: controller.signal,
      }),
    )
    const checks = results.map((result) => expect(result).rejects.toThrow())
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]?.id).toMatch(/^mcp-/)
    expect(calls[0]?.id).not.toBe(calls[1]?.id)
    controllers[0]?.abort()
    await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true))
    expect(calls[1]?.signal?.aborted).toBe(false)
    controllers[1]?.abort()
    await Promise.all(checks)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
  } finally {
    await client.close()
    await server.close()
  }
})

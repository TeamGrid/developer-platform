import { describe, expect, it, vi } from 'vitest'
import { createRegionalMcpAdmission } from './admission.js'

describe('shared regional MCP admission', () => {
  it('sends a stable keyed identity without the bearer and preserves the request deadline', async () => {
    const fetcher = vi.fn(async () => Response.json({ admitted: true }))
    const admit = createRegionalMcpAdmission('https://auth.example.test/', 's'.repeat(48), fetcher)
    const request = new Request('https://mcp.example.test/mcp', {
      headers: { Authorization: 'Bearer private-access' },
    })
    expect(await admit(request)).toBe(true)
    expect(await admit(request)).toBe(true)
    const calls = fetcher.mock.calls as unknown as [URL, RequestInit][]
    expect(calls[0]?.[1].signal).toBe(request.signal)
    expect(calls[0]?.[1].body).toEqual(calls[1]?.[1].body)
    expect(calls[0]?.[1].body).not.toContain('private-access')
    expect(calls[0]?.[1].redirect).toBe('error')
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })
  it('distinguishes capacity rejection from provider failure and refuses malformed replies', async () => {
    const request = new Request('https://mcp.example.test/mcp')
    const run = (response: Response) =>
      createRegionalMcpAdmission(
        'https://auth.example.test/',
        's'.repeat(48),
        async () => response,
      )(request)
    await expect(
      run(new Response(null, { status: 429, headers: { 'Retry-After': '120' } })),
    ).rejects.toMatchObject({ retryAfter: '120' })
    expect(await run(Response.json({ admitted: false }))).toBe(false)
    for (const response of [
      new Response(null, { status: 503 }),
      Response.json({ admitted: 'true' }),
      Response.json({ admitted: true, secret: 'private' }),
      new Response('x'.repeat(1025)),
    ])
      await expect(run(response)).rejects.toThrow('MCP admission unavailable')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createMcpReadinessProbe } from './readiness.js'

const issuer = 'https://auth.example.test/'
const document = {
  issuer,
  token_endpoint: `${issuer}oauth/token`,
  code_challenge_methods_supported: ['S256'],
}
describe('hosted MCP readiness', () => {
  it('coalesces and caches a bounded issuer check while respecting the runtime gate', async () => {
    let enabled = true
    const fetcher = vi.fn(async () => Response.json(document))
    const probe = createMcpReadinessProbe(issuer, () => enabled, fetcher)
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true])
    expect(fetcher).toHaveBeenCalledOnce()
    enabled = false
    expect(await probe()).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not mark an outage, wrong issuer, unsafe redirect or oversized metadata as ready', async () => {
    for (const response of [
      Response.json({ ...document, issuer: 'https://foreign.example.test/' }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 302, headers: { Location: 'https://foreign.example.test/' } }),
      new Response('x'.repeat(32769)),
    ]) {
      const fetcher = vi.fn(async () => response)
      expect(await createMcpReadinessProbe(issuer, () => true, fetcher)()).toBe(false)
      expect(fetcher).toHaveBeenCalledWith(
        new URL(`${issuer}.well-known/oauth-authorization-server`),
        expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
      )
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'

const token = `tg_pat_v2_de_de-nbg-001_0123456789abcdef01234567_${'a'.repeat(64)}` // gitleaks:allow -- synthetic fixed-format test credential
const grantId = 'authorization_request_1234567890'

describe('CLI authorization storage compensation', () => {
  it('uses the authenticating credential and exact browser grant without exposing a target id', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(JSON.parse(String(init?.body))).toEqual({ grantId })
      return new Response(null, {
        headers: {
          'cache-control': 'private, no-store, no-transform',
          'x-request-id': 'request-1',
        },
        status: 204,
      })
    })
    const client = new TeamGridClient({ fetch, retries: 0, token })

    await expect(client.authorization.compensateCliStorage(grantId)).resolves.toMatchObject({
      status: 204,
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects an invalid grant before making a network request', async () => {
    const fetch = vi.fn()
    const client = new TeamGridClient({ fetch, token })
    await expect(client.authorization.compensateCliStorage('../wrong')).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed on an unexpected empty-response contract', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
      retries: 0,
      token,
    })
    await expect(client.authorization.compensateCliStorage(grantId)).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })
})

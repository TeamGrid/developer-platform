import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import { TeamGridApiError, TeamGridClientError } from './errors.js'
import { buildRegionalApiBaseUrl, normalizeApiBaseUrl, parseCredentialLocation } from './routing.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function taskPage(nextCursor: string | null) {
  return {
    data: [{ attributes: { name: 'Task' }, id: 'task-1', type: 'task' }],
    meta: { page: { limit: 1, nextCursor }, requestId: 'request-1' },
  }
}

describe('TeamGrid API client', () => {
  it('derives a regional endpoint without exposing the credential secret', () => {
    expect(parseCredentialLocation(token)).toEqual({
      cellId: 'us-mnz-001',
      credentialId: '0123456789abcdef01234567',
      region: 'us',
    })
    expect(buildRegionalApiBaseUrl('us')).toBe('https://api.us.teamgrid.app/v1')
    expect(normalizeApiBaseUrl('http://localhost:2201/v1/')).toBe('http://localhost:2201/v1')
    expect(normalizeApiBaseUrl('http://[::1]:2201/v1/')).toBe('http://[::1]:2201/v1')
    expect(() => normalizeApiBaseUrl('http://api.teamgrid.app/v1')).toThrow(TeamGridClientError)
  })

  it('sends tenant credentials in headers and preserves response metadata', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe('https://api.us.teamgrid.app/v1/tasks')
      expect(Object.fromEntries(url.searchParams)).toEqual({ completed: 'false', limit: '1' })
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('x-request-id')).toBe('client-request')
      return json(taskPage(null))
    })
    const client = new TeamGridClient({ fetch, token })
    const page = await client.tasks.list({
      completed: false,
      limit: 1,
      requestId: 'client-request',
    })
    expect(page.meta.requestId).toBe('request-1')
    expect(page.data[0]?.id).toBe('task-1')
  })

  it('retries safe reads and idempotent creates but not patches', async () => {
    const sleep = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ errors: [] }, 503, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(taskPage(null)))
      .mockResolvedValueOnce(json({ errors: [] }, 503))
      .mockResolvedValueOnce(
        json(
          {
            data: { attributes: { name: 'Created' }, id: 'task-2', type: 'task' },
            meta: { requestId: 'request-2' },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            errors: [
              {
                code: 'upstream_error',
                detail: 'Unavailable',
                status: '503',
                title: 'Unavailable',
              },
            ],
            meta: { requestId: 'request-3' },
          },
          503,
        ),
      )
    const client = new TeamGridClient({ fetch, random: () => 0, sleep, token })

    await client.tasks.list()
    await client.tasks.create({ name: 'Created' }, { idempotencyKey: 'stable-key' })
    await expect(client.tasks.update('task-2', { name: 'Changed' })).rejects.toBeInstanceOf(
      TeamGridApiError,
    )
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls[0]?.[0]).toBe(1000)
  })

  it('iterates stable pages and detects cursor cycles', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(taskPage('next')))
      .mockResolvedValueOnce(json(taskPage(null)))
    const client = new TeamGridClient({ fetch, token })
    const pages = []
    for await (const page of client.tasks.pages({ limit: 1 })) pages.push(page)
    expect(pages).toHaveLength(2)

    const cyclic = new TeamGridClient({
      fetch: vi.fn(async () => json(taskPage('same'))),
      token,
    })
    await expect(async () => {
      for await (const _page of cyclic.tasks.pages()) {
        // exhaust the iterator
      }
    }).rejects.toMatchObject({ code: 'pagination_cycle' })
  })

  it('surfaces versioned API errors without retaining the bearer token', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        json(
          {
            errors: [
              {
                code: 'insufficient_scope',
                detail: 'Missing scope.',
                status: '403',
                title: 'Forbidden',
              },
            ],
            meta: { requestId: 'request-error' },
          },
          403,
        ),
      ),
      token,
    })
    const error = await client.tasks.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TeamGridApiError)
    expect(error).toMatchObject({ requestId: 'request-error', status: 403 })
    expect(JSON.stringify(error)).not.toContain(token)
  })

  it('rejects oversized and structurally invalid successful responses', async () => {
    const oversized = new TeamGridClient({
      fetch: vi.fn(async () => json({ padding: 'x'.repeat(2000) })),
      maxResponseBytes: 1024,
      token,
    })
    await expect(oversized.tasks.list()).rejects.toMatchObject({ code: 'response_too_large' })

    const wrongResource = new TeamGridClient({
      fetch: vi.fn(async () =>
        json({
          data: [{ attributes: {}, id: 'call-1', type: 'call' }],
          meta: { page: { limit: 1, nextCursor: null }, requestId: 'request-invalid' },
        }),
      ),
      token,
    })
    await expect(wrongResource.tasks.list()).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('uses the same typed transport for idempotent webhook management', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/webhooks')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('webhook-request-1')
      expect(JSON.parse(String(init?.body))).toEqual({
        actions: ['task_created'],
        url: 'https://hooks.example.com/teamgrid',
      })
      return json(
        {
          data: {
            attributes: {
              actions: ['task_created'],
              disabled: false,
              failCount: 0,
              lastStatus: null,
              url: 'https://hooks.example.com/teamgrid',
            },
            id: 'webhook-1',
            type: 'webhook',
          },
          meta: { requestId: 'request-webhook' },
        },
        201,
      )
    })
    const client = new TeamGridClient({ fetch, token })
    const result = await client.webhooks.create(
      { actions: ['task_created'], url: 'https://hooks.example.com/teamgrid' },
      { idempotencyKey: 'webhook-request-1' },
    )
    expect(result.data.id).toBe('webhook-1')
  })
})

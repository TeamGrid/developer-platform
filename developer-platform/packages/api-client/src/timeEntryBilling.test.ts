import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import { TeamGridClientError } from './errors.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_de_de-nbg-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const revision = `tib1-${'a'.repeat(64)}`
const nextRevision = `tib1-${'b'.repeat(64)}`
const cacheControl = 'private, no-store, no-transform'

function billing(billed: boolean, currentRevision = revision) {
  return {
    attributes: {
      billed,
      billedAt: billed ? '2026-07-27T12:00:00.000Z' : null,
      revision: currentRevision,
    },
    id: 'time-1',
    type: 'timeEntryBilling',
  } as const
}

function response(data: unknown, currentRevision: string) {
  return new Response(
    JSON.stringify({
      data,
      meta: { requestId: 'request-billing' },
    }),
    {
      headers: {
        'cache-control': cacheControl,
        'content-type': 'application/json',
        etag: `"${currentRevision}"`,
      },
      status: 200,
    },
  )
}

describe('time-entry billing SDK surface', () => {
  it('reads and conflict-safely updates exact billing state', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/time-entries/time-1/billing')
      if ((init?.method || 'GET') === 'GET') {
        return response(billing(false), revision)
      }
      const headers = new Headers(init?.headers)
      expect(init?.method).toBe('PUT')
      expect(headers.get('if-match')).toBe(`"${revision}"`)
      expect(JSON.parse(String(init?.body))).toEqual({ billed: true })
      return response(billing(true, nextRevision), nextRevision)
    })
    const client = new TeamGridClient({ fetch, retries: 0, token })

    const current = await client.timeEntries.getBilling('time-1')
    expect(current.data.attributes).toEqual({
      billed: false,
      billedAt: null,
      revision,
    })
    expect(current.transport.headers.etag).toBe(`"${revision}"`)

    const updated = await client.timeEntries.updateBilling(
      'time-1',
      { billed: true },
      { ifMatch: revision },
    )
    expect(updated.data.attributes.revision).toBe(nextRevision)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects unsafe input and response drift', async () => {
    const client = new TeamGridClient({
      fetch: async () =>
        response(
          {
            ...billing(false),
            attributes: {
              ...billing(false).attributes,
              billedAt: '2026-07-27T12:00:00.000Z',
            },
          },
          revision,
        ),
      retries: 0,
      token,
    })
    expect(() =>
      client.timeEntries.updateBilling('time-1', { billed: 'yes' } as never, { ifMatch: revision }),
    ).toThrow(TeamGridClientError)
    await expect(client.timeEntries.getBilling('time-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })
})

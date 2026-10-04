import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'

const token = `tg_sk_v1_de_de-nbg-001_0123456789abcdef01234567_${'a'.repeat(64)}` // gitleaks:allow
describe('required core CAS transport', () => {
  it.each([false, true])(
    'only sends the additive required-CAS opt-in when configured: %s',
    async (required) => {
      const fetch = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              data: { id: 'workspace1', type: 'workspace', attributes: {} },
              meta: { requestId: 'request-1' },
            }),
            {
              headers: {
                'content-type': 'application/json',
                'x-teamgrid-resource-cas': 'required-v1',
              },
            },
          ),
      )
      const client = new TeamGridClient({ token, fetch, requireResourceCas: required })
      const result = await client.workspace.get()
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-teamgrid-resource-cas')).toBe(
        required ? 'required-v1' : null,
      )
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-teamgrid-snapshot-cas')).toBe(
        required ? 'required-v1' : null,
      )
      expect(result.transport.headers['x-teamgrid-resource-cas']).toBe('required-v1')
      expect(JSON.stringify(result)).not.toContain('transport')
    },
  )
  it.each(['contact', 'timeEntry'] as const)('protects %s edits before dispatch', async (kind) => {
    const prefix = kind === 'contact' ? 'ct1' : 'tme1'
    const etag = `"${prefix}-${'a'.repeat(64)}"`
    const fetch = vi.fn(async () =>
      Response.json({
        data: { id: 'resource1', type: kind, attributes: {} },
        meta: { requestId: 'test' },
      }),
    )
    const client = new TeamGridClient({ token, fetch, requireResourceCas: true })
    const update = (ifMatch?: string) =>
      kind === 'contact'
        ? client.contacts.update('resource1', { firstName: 'New' }, { ifMatch })
        : client.timeEntries.update('resource1', { comment: 'New' }, { ifMatch })
    await expect(update()).rejects.toMatchObject({ code: 'revision_required' })
    for (const invalid of ['*', `W/${etag}`, `${etag}, ${etag}`, `"other-${'a'.repeat(64)}"`]) {
      await expect(update(invalid)).rejects.toMatchObject({ code: 'invalid_arguments' })
    }
    expect(fetch).not.toHaveBeenCalled()
    await update(etag)
    expect(fetch).toHaveBeenCalledOnce()
    const init = (fetch.mock.calls as unknown as [string, RequestInit][])[0]?.[1]
    expect(new Headers(init?.headers).get('if-match')).toBe(etag)
    expect(new Headers(init?.headers).get('x-teamgrid-snapshot-cas')).toBe('required-v1')
    expect(JSON.parse(String(init?.body))).toEqual(
      kind === 'contact' ? { firstName: 'New' } : { comment: 'New' },
    )
  })
})

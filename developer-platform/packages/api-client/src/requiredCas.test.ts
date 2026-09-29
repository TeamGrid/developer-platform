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
      expect(result.transport.headers['x-teamgrid-resource-cas']).toBe('required-v1')
      expect(JSON.stringify(result)).not.toContain('transport')
    },
  )
})

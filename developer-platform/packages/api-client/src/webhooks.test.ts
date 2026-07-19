import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { TeamGridWebhookVerificationError, verifyTeamGridWebhook } from './webhooks.js'

const signingSecret = `whsec_v2_${'a'.repeat(43)}`
const timestamp = 1_700_000_000
const body = JSON.stringify({ event: 'task_created', item: { _id: 'task-1' } })

function headers(overrides: Record<string, string> = {}) {
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')
  return {
    'x-teamgrid-webhook-id': 'delivery-1',
    'x-teamgrid-webhook-signature': `v1=${signature}`,
    'x-teamgrid-webhook-timestamp': String(timestamp),
    'x-teamgrid-webhook-version': '2',
    ...overrides,
  }
}

describe('TeamGrid webhook verification', () => {
  it('verifies the exact raw body and exposes deduplication metadata', async () => {
    const claim = vi.fn(async () => true)
    await expect(
      verifyTeamGridWebhook({
        body: new TextEncoder().encode(body),
        deduplicationStore: { claim },
        headers: headers(),
        now: timestamp * 1000,
        signingSecret,
      }),
    ).resolves.toEqual({
      deliveryId: 'delivery-1',
      payload: { event: 'task_created', item: { _id: 'task-1' } },
      timestamp,
    })
    expect(claim).toHaveBeenCalledWith('delivery-1', new Date((timestamp + 300) * 1000))
  })

  it('rejects modified, malformed, stale, and duplicate deliveries', async () => {
    await expect(
      verifyTeamGridWebhook({
        body: `${body} `,
        headers: headers(),
        now: timestamp * 1000,
        signingSecret,
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(
      verifyTeamGridWebhook({
        body,
        headers: headers({ 'x-teamgrid-webhook-signature': 'v1=not-hex' }),
        now: timestamp * 1000,
        signingSecret,
      }),
    ).rejects.toBeInstanceOf(TeamGridWebhookVerificationError)
    await expect(
      verifyTeamGridWebhook({
        body,
        headers: headers(),
        now: (timestamp + 301) * 1000,
        signingSecret,
      }),
    ).rejects.toMatchObject({ code: 'stale_timestamp' })
    await expect(
      verifyTeamGridWebhook({
        body,
        deduplicationStore: { claim: async () => false },
        headers: headers(),
        now: timestamp * 1000,
        signingSecret,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_delivery' })
  })
})

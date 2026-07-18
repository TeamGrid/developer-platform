import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createWebhookSiteReceiver,
  verifySignedWebhook,
} from './signed-webhook-receiver.mjs'

const signingSecret = `whsec_v2_${'a'.repeat(43)}`
const timestamp = 1_700_000_000
const body = JSON.stringify({ event: 'task_created', item: { _id: 'task-1' } })

function headers(overrides = {}) {
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

describe('signed staging webhook receiver', () => {
  it('verifies the exact raw body and v2 delivery metadata', () => {
    expect(verifySignedWebhook({
      body,
      headers: headers(),
      now: timestamp * 1000,
      signingSecret,
    })).toEqual({
      deliveryId: 'delivery-1',
      payload: { event: 'task_created', item: { _id: 'task-1' } },
      timestamp,
    })
  })

  it('rejects modified bodies, stale timestamps, and wrong versions', () => {
    expect(() => verifySignedWebhook({
      body: `${body} `,
      headers: headers(),
      now: timestamp * 1000,
      signingSecret,
    })).toThrow('signature is invalid')
    expect(() => verifySignedWebhook({
      body,
      headers: headers(),
      now: (timestamp + 301) * 1000,
      signingSecret,
    })).toThrow('outside the accepted window')
    expect(() => verifySignedWebhook({
      body,
      headers: headers({ 'x-teamgrid-webhook-version': '1' }),
      now: timestamp * 1000,
      signingSecret,
    })).toThrow('metadata is invalid')
  })

  it('captures, verifies, and deletes a disposable public receiver', async () => {
    const tokenId = '11111111-2222-3333-4444-555555555555'
    const liveTimestamp = Math.floor(Date.now() / 1000)
    const liveBody = JSON.stringify({ event: 'task_created', item: { _id: 'task-live' } })
    const signature = createHmac('sha256', signingSecret)
      .update(`${liveTimestamp}.${liveBody}`, 'utf8')
      .digest('hex')
    const calls = []
    const fetchImpl = async (url, options = {}) => {
      calls.push({ method: options.method || 'GET', url })
      if (url === 'https://webhook.site/token' && options.method === 'POST') {
        return new Response(JSON.stringify({ uuid: tokenId }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
      }
      if (url.endsWith('/requests?sorting=newest&per_page=10')) {
        return new Response(JSON.stringify({
          data: [{
            content: liveBody,
            headers: {
              'x-teamgrid-webhook-id': 'delivery-live',
              'x-teamgrid-webhook-signature': `v1=${signature}`,
              'x-teamgrid-webhook-timestamp': String(liveTimestamp),
              'x-teamgrid-webhook-version': '2',
            },
            method: 'POST',
          }],
        }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
      }
      if (url === `https://webhook.site/token/${tokenId}` && options.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    }

    const receiver = await createWebhookSiteReceiver({ fetchImpl, pollIntervalMs: 0 })
    receiver.setSigningSecret(signingSecret)
    await expect(receiver.waitForDelivery(100)).resolves.toMatchObject({
      deliveryId: 'delivery-live',
      payload: { event: 'task_created', item: { _id: 'task-live' } },
    })
    await receiver.close()

    expect(receiver.url).toBe(`https://webhook.site/${tokenId}`)
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET', 'DELETE'])
  })
})

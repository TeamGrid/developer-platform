import { spawn } from 'node:child_process'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60
const WEBHOOK_SITE_BASE_URL = 'https://webhook.site'

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || ''
  const key = Object.keys(headers || {}).find(candidate => candidate.toLowerCase() === name)
  const value = key ? headers[key] : ''
  return Array.isArray(value) ? value[0] || '' : String(value || '')
}

export function verifySignedWebhook({ body, headers, now = Date.now(), signingSecret }) {
  if (!/^whsec_v2_[A-Za-z0-9_-]{43}$/.test(signingSecret || '')) {
    throw new Error('Webhook signing secret is unavailable.')
  }

  const deliveryId = headerValue(headers, 'x-teamgrid-webhook-id')
  const signature = headerValue(headers, 'x-teamgrid-webhook-signature')
  const timestampText = headerValue(headers, 'x-teamgrid-webhook-timestamp')
  const version = headerValue(headers, 'x-teamgrid-webhook-version')
  if (!deliveryId || version !== '2' || !/^\d{10}$/.test(timestampText)) {
    throw new Error('Webhook signature metadata is invalid.')
  }

  const timestamp = Number(timestampText)
  if (Math.abs(Math.floor(now / 1000) - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    throw new Error('Webhook timestamp is outside the accepted window.')
  }

  const expected = `v1=${createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')}`
  const actualBytes = Buffer.from(signature, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (
    actualBytes.length !== expectedBytes.length
    || !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new Error('Webhook signature is invalid.')
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error('Webhook body is not valid JSON.')
  }
  return { deliveryId, payload, timestamp }
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

async function waitForPublicReceiver(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) return
    } catch {
      // Quick Tunnel DNS and edge routing can become visible shortly after the
      // connection itself is registered. Retry only within the startup bound.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Timed out probing the public signed webhook receiver.')
}

export async function createSignedWebhookReceiver({
  cloudflaredBinary = process.env.CLOUDFLARED_BINARY || 'cloudflared',
  probeTimeoutMs = 20_000,
  startupTimeoutMs = 45_000,
} = {}) {
  const pathToken = randomUUID()
  let signingSecret = ''
  let deliveryResolve
  let deliveryReject
  let settled = false
  const delivery = new Promise((resolve, reject) => {
    deliveryResolve = resolve
    deliveryReject = reject
  })

  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== `/hook/${pathToken}`) {
      response.writeHead(404).end()
      return
    }

    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        const verified = verifySignedWebhook({
          body,
          headers: request.headers,
          signingSecret,
        })
        response.writeHead(204).end()
        if (!settled) {
          settled = true
          deliveryResolve(verified)
        }
      } catch {
        response.writeHead(401).end()
      }
    })
    request.on('error', error => {
      if (!settled) {
        settled = true
        deliveryReject(error)
      }
    })
  })
  await waitForServer(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Could not allocate the local webhook receiver port.')
  }

  const tunnel = spawn(cloudflaredBinary, [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://127.0.0.1:${address.port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let publicBaseUrl = ''
  let connected = false
  let startupResolve
  let startupReject
  let startupSettled = false
  const startup = new Promise((resolve, reject) => {
    startupResolve = resolve
    startupReject = reject
  })
  const consumeOutput = chunk => {
    const output = chunk.toString('utf8')
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
    if (match) publicBaseUrl = match[0]
    if (output.includes('Registered tunnel connection')) connected = true
    if (publicBaseUrl && connected && !startupSettled) {
      startupSettled = true
      startupResolve()
    }
  }
  tunnel.stdout.on('data', consumeOutput)
  tunnel.stderr.on('data', consumeOutput)
  tunnel.once('error', error => {
    if (!startupSettled) {
      startupSettled = true
      startupReject(error)
    }
  })
  tunnel.once('exit', code => {
    if (!startupSettled) {
      startupSettled = true
      startupReject(new Error(`cloudflared exited before startup (code ${code ?? 'unknown'}).`))
    }
  })

  try {
    await withTimeout(startup, startupTimeoutMs, 'Timed out starting the signed webhook tunnel.')
    await waitForPublicReceiver(`${publicBaseUrl}/hook/${pathToken}`, probeTimeoutMs)
    // Give independent recursive resolvers a short window after the first
    // successful public lookup before the remote cell attempts delivery.
    await new Promise(resolve => setTimeout(resolve, 3_000))
  } catch (error) {
    tunnel.kill('SIGTERM')
    await closeServer(server)
    throw error
  }

  return {
    setSigningSecret(value) {
      const normalized = String(value || '').trim()
      if (!/^whsec_v2_[A-Za-z0-9_-]{43}$/.test(normalized)) {
        throw new Error('Webhook signing secret has an invalid format.')
      }
      signingSecret = normalized
    },
    async waitForDelivery(timeoutMs = 90_000) {
      return withTimeout(delivery, timeoutMs, 'Timed out waiting for a signed webhook delivery.')
    },
    async close() {
      tunnel.kill('SIGTERM')
      await closeServer(server)
    },
    url: `${publicBaseUrl}/hook/${pathToken}`,
  }
}

export async function createWebhookSiteReceiver({
  fetchImpl = fetch,
  pollIntervalMs = 1_000,
} = {}) {
  const createResponse = await fetchImpl(`${WEBHOOK_SITE_BASE_URL}/token`, {
    body: JSON.stringify({
      default_content: '',
      default_content_type: 'text/plain',
      default_status: 204,
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  if (!createResponse.ok) throw new Error('Could not create the webhook capture token.')
  const token = await createResponse.json()
  const tokenId = String(token?.uuid || '')
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tokenId)) {
    throw new Error('Webhook capture returned an invalid token.')
  }

  let signingSecret = ''
  return {
    setSigningSecret(value) {
      const normalized = String(value || '').trim()
      if (!/^whsec_v2_[A-Za-z0-9_-]{43}$/.test(normalized)) {
        throw new Error('Webhook signing secret has an invalid format.')
      }
      signingSecret = normalized
    },
    async waitForDelivery(timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const response = await fetchImpl(
          `${WEBHOOK_SITE_BASE_URL}/token/${tokenId}/requests?sorting=newest&per_page=10`,
          { headers: { accept: 'application/json' } },
        )
        if (response.ok) {
          const page = await response.json()
          const request = (Array.isArray(page?.data) ? page.data : [])
            .find(candidate => candidate?.method === 'POST')
          if (request) {
            return verifySignedWebhook({
              body: String(request.content || ''),
              headers: request.headers,
              signingSecret,
            })
          }
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      }
      throw new Error('Timed out waiting for a captured signed webhook delivery.')
    },
    async close() {
      const response = await fetchImpl(`${WEBHOOK_SITE_BASE_URL}/token/${tokenId}`, {
        headers: { accept: 'application/json' },
        method: 'DELETE',
      })
      if (!response.ok && response.status !== 404) {
        throw new Error('Could not delete the webhook capture token.')
      }
    },
    url: `${WEBHOOK_SITE_BASE_URL}/${tokenId}`,
  }
}

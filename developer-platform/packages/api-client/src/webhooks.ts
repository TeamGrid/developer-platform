export type TeamGridWebhookHeaders =
  | Headers
  | Record<string, string | readonly string[] | undefined>

export type TeamGridWebhookDeduplicationStore = {
  claim(deliveryId: string, expiresAt: Date): Promise<boolean> | boolean
}

export type VerifyTeamGridWebhookOptions = {
  body: string | Uint8Array
  deduplicationStore?: TeamGridWebhookDeduplicationStore
  headers: TeamGridWebhookHeaders
  maxTimestampSkewSeconds?: number
  now?: number | Date
  signingSecret: string
}

export type VerifiedTeamGridWebhook<T = unknown> = {
  deliveryId: string
  payload: T
  timestamp: number
}

export class TeamGridWebhookVerificationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TeamGridWebhookVerificationError'
  }
}

function verificationError(code: string, message: string): never {
  throw new TeamGridWebhookVerificationError(code, message)
}

function headerValue(headers: TeamGridWebhookHeaders, name: string) {
  if (headers instanceof Headers) return headers.get(name) || ''
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  const value = key ? headers[key] : undefined
  return Array.isArray(value) ? value[0] || '' : String(value || '')
}

function bodyBytes(body: string | Uint8Array) {
  return typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)
}

function signatureMessage(timestamp: string, rawBody: Uint8Array) {
  const prefix = new TextEncoder().encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength)
  message.set(prefix)
  message.set(rawBody, prefix.byteLength)
  return message
}

function hexBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0)
  }
  return difference === 0
}

function webCrypto() {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    verificationError(
      'crypto_unavailable',
      'Web Crypto is required to verify TeamGrid webhook signatures.',
    )
  }
  return crypto
}

export async function verifyTeamGridWebhook<T = unknown>({
  body,
  deduplicationStore,
  headers,
  maxTimestampSkewSeconds = 300,
  now = Date.now(),
  signingSecret,
}: VerifyTeamGridWebhookOptions): Promise<VerifiedTeamGridWebhook<T>> {
  if (!/^whsec_v2_[A-Za-z0-9_-]{43}$/.test(signingSecret)) {
    verificationError('invalid_secret', 'The TeamGrid webhook signing secret is invalid.')
  }
  const deliveryId = headerValue(headers, 'x-teamgrid-webhook-id')
  const signature = headerValue(headers, 'x-teamgrid-webhook-signature')
  const timestampText = headerValue(headers, 'x-teamgrid-webhook-timestamp')
  const version = headerValue(headers, 'x-teamgrid-webhook-version')
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(deliveryId) ||
    version !== '2' ||
    !/^\d{10}$/.test(timestampText)
  ) {
    verificationError('invalid_metadata', 'The TeamGrid webhook signature metadata is invalid.')
  }
  const signatureMatch = /^v1=([0-9a-f]{64})$/.exec(signature)
  if (!signatureMatch) {
    verificationError('invalid_signature', 'The TeamGrid webhook signature is invalid.')
  }
  const maximumSkew = Math.max(30, Math.min(Math.trunc(maxTimestampSkewSeconds), 3600))
  const nowMs = now instanceof Date ? now.getTime() : now
  const timestamp = Number(timestampText)
  if (!Number.isFinite(nowMs) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > maximumSkew) {
    verificationError(
      'stale_timestamp',
      'The TeamGrid webhook timestamp is outside the accepted window.',
    )
  }

  const rawBody = bodyBytes(body)
  const crypto = webCrypto()
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, signatureMessage(timestampText, rawBody)),
  )
  if (!constantTimeEqual(expected, hexBytes(signatureMatch[1] as string))) {
    verificationError('invalid_signature', 'The TeamGrid webhook signature is invalid.')
  }

  let payload: T
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as T
  } catch {
    verificationError('invalid_json', 'The TeamGrid webhook body is not valid JSON.')
  }
  if (
    deduplicationStore &&
    !(await deduplicationStore.claim(deliveryId, new Date((timestamp + maximumSkew) * 1000)))
  ) {
    verificationError('duplicate_delivery', 'The TeamGrid webhook delivery was already processed.')
  }
  return { deliveryId, payload, timestamp }
}

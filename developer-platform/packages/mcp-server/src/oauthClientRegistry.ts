import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { withinSignal } from './http.js'
import { fetchOAuthClientMetadata } from './oauthClientMetadataFetcher.js'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'

function invalid(): never {
  throw new OAuthBrokerInvalidClientError()
}
export const oauthClientRegistrationSchema = z
  .object({
    _id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    clientId: z.string().min(1).max(2048),
    name: z
      .string()
      .max(160)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          !Array.from(value).some((character) => character < ' ' || character === '\u007f'),
      ),
    redirectUris: z.array(z.string().max(2048)).min(1).max(10),
    status: z.enum(['active', 'revoked']),
    tokenEndpointAuthMethod: z
      .enum(['none', 'client_secret_basic', 'client_secret_post'])
      .optional(),
    secretHashes: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(2)
      .optional(),
  })
  .strict()
export type OAuthClientRegistration = z.infer<typeof oauthClientRegistrationSchema>
export type OAuthClientRegistry = {
  resolve(clientId: string, signal: AbortSignal): Promise<OAuthClientRegistration>
  authenticate(
    parameters: Readonly<Record<string, string>>,
    authorization: string | null,
    signal: AbortSignal,
  ): Promise<void>
  metadataSupported(): boolean
}
export type OAuthMetadataDocument = {
  body: unknown
  cacheControl: string | null
  age: string | null
}

function validateClient(value: unknown) {
  const client = oauthClientRegistrationSchema.parse(structuredClone(value))
  if (new Set(client.redirectUris).size !== client.redirectUris.length) invalid()
  for (const value of client.redirectUris) {
    const url = new URL(value)
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.href !== value ||
      value.includes('*') ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      invalid()
  }
  if ((client.tokenEndpointAuthMethod ?? 'none') === 'none') {
    if (client.secretHashes !== undefined) invalid()
  } else if (!client.secretHashes) invalid()
  return client
}

export function oauthClientMetadataUrl(clientId: string, origins: readonly string[]) {
  try {
    const url = new URL(clientId)
    if (
      clientId.length > 2048 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      url.pathname === '/' ||
      url.href !== clientId ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !origins.includes(url.origin)
    )
      invalid()
    return url
  } catch {
    return invalid()
  }
}

export function parseOAuthClientMetadata(clientId: string, body: unknown) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid()
    const input = body as Record<string, unknown>
    const methods = input.token_endpoint_auth_methods_supported
    const supportsPublic =
      methods === undefined
        ? input.token_endpoint_auth_method === undefined ||
          input.token_endpoint_auth_method === 'none'
        : Array.isArray(methods) &&
          methods.length > 0 &&
          methods.length <= 10 &&
          new Set(methods).size === methods.length &&
          methods.includes('none') &&
          methods.every(
            (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value),
          )
    if (
      input.client_id !== clientId ||
      !supportsPublic ||
      (input.grant_types !== undefined &&
        (!Array.isArray(input.grant_types) ||
          !input.grant_types.includes('authorization_code') ||
          input.grant_types.some(
            (value) => !['authorization_code', 'refresh_token'].includes(value),
          ))) ||
      (input.response_types !== undefined &&
        (!Array.isArray(input.response_types) ||
          input.response_types.length !== 1 ||
          input.response_types[0] !== 'code'))
    )
      invalid()
    return validateClient({
      _id: `cimd_${createHash('sha256').update(clientId).digest('hex')}`,
      clientId,
      name: input.client_name,
      redirectUris: input.redirect_uris,
      status: 'active',
      tokenEndpointAuthMethod: 'none',
    })
  } catch {
    return invalid()
  }
}

function cacheMs(cacheControl: string | null, age: string | null) {
  if (!cacheControl || /(?:^|,)\s*(?:no-store|no-cache)(?:\s|,|=|$)/i.test(cacheControl)) return 0
  const matches = [...cacheControl.matchAll(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?=\s*(?:,|$))/gi)]
  if (matches.length !== 1 || (age !== null && !/^\d+$/.test(age))) return 0
  const seconds = Number(matches[0]?.[1]) - Number(age ?? 0)
  return Number.isFinite(seconds) ? Math.max(0, Math.min(300, seconds)) * 1000 : 0
}

/** The operator must supply the same static registry and CIMD policy to every owning regional App. */
export function createOAuthClientRegistry(options: {
  registeredClients(): readonly OAuthClientRegistration[]
  allowedMetadataOrigins(): readonly string[]
  metadataSupported(): boolean
  fetchMetadata?(url: URL, signal: AbortSignal): Promise<OAuthMetadataDocument>
  now?: () => number
}): OAuthClientRegistry {
  const cache = new Map<string, { client: OAuthClientRegistration; expiresAt: number }>()
  const pending = new Map<string, Promise<OAuthClientRegistration>>()
  const clock = () => {
    const time = (options.now ?? Date.now)()
    if (!Number.isFinite(time)) throw new Error('OAuth client registry clock unavailable.')
    return time
  }
  const metadataSupported = () => {
    const enabled = options.metadataSupported()
    if (typeof enabled !== 'boolean') throw new Error('Invalid OAuth metadata policy.')
    return enabled
  }
  const configured = (clientId: string) => {
    const values = options.registeredClients()
    if (!Array.isArray(values) || values.length > 50) throw new Error('Invalid OAuth registry.')
    let clients: OAuthClientRegistration[]
    try {
      clients = values.map(validateClient)
    } catch {
      throw new Error('Invalid OAuth registry.')
    }
    if (JSON.stringify(clients).length > 65536) throw new Error('OAuth registry size exceeded.')
    if (
      new Set(clients.map((client) => client.clientId)).size !== clients.length ||
      new Set(clients.map((client) => client._id)).size !== clients.length
    ) {
      throw new Error('Duplicate OAuth registration.')
    }
    const registered = clients.find((client) => client.clientId === clientId)
    if (registered) {
      if (registered.status !== 'active') invalid()
    }
    return registered
  }
  const resolve = async (clientId: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const registered = configured(clientId)
    if (registered) return registered
    if (!metadataSupported()) invalid()
    const origins = options.allowedMetadataOrigins()
    if (
      !Array.isArray(origins) ||
      origins.length < 1 ||
      origins.length > 50 ||
      new Set(origins).size !== origins.length ||
      JSON.stringify(origins).length > 8192
    )
      throw new Error('Invalid OAuth metadata origins.')
    for (const origin of origins) {
      const url = new URL(origin)
      if (
        url.protocol !== 'https:' ||
        url.origin !== origin ||
        url.port ||
        isIP(url.hostname.replace(/^\[|\]$/g, ''))
      )
        throw new Error('Invalid OAuth metadata origin.')
    }
    const url = oauthClientMetadataUrl(clientId, origins)
    const cached = cache.get(url.href)
    if (cached && cached.expiresAt > clock()) return structuredClone(cached.client)
    cache.delete(url.href)
    const existing = pending.get(url.href)
    if (existing) return structuredClone(await withinSignal(existing, signal))
    if (pending.size >= 8) throw new Error('OAuth metadata capacity unavailable.')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])
    const work = (async () => {
      const metadata = await withinSignal(
        (options.fetchMetadata ?? fetchOAuthClientMetadata)(url, deadline),
        deadline,
      )
      deadline.throwIfAborted()
      const client = parseOAuthClientMetadata(url.href, metadata.body)
      // Trust can change during DNS/HTTP I/O. Never store/return after removing the origin.
      if (!metadataSupported() || !options.allowedMetadataOrigins().includes(url.origin)) invalid()
      const current = configured(clientId)
      if (current) return current
      const lifetime = cacheMs(metadata.cacheControl, metadata.age)
      if (lifetime > 0) {
        while (cache.size >= 100) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(url.href, { client: structuredClone(client), expiresAt: clock() + lifetime })
      }
      return client
    })()
    pending.set(url.href, work)
    try {
      return structuredClone(await work)
    } finally {
      pending.delete(url.href)
    }
  }
  const authenticate = async (
    parameters: Readonly<Record<string, string>>,
    header: string | null,
    signal: AbortSignal,
  ) => {
    let clientId = parameters.client_id,
      secret = parameters.client_secret
    let method = secret === undefined ? 'none' : 'client_secret_post'
    if (header !== null) {
      if (
        secret !== undefined ||
        header.length > 4096 ||
        !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)
      )
        invalid()
      try {
        const encoded = header.slice(6),
          bytes = Buffer.from(encoded, 'base64')
        if (bytes.toString('base64') !== encoded) invalid()
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const separator = value.indexOf(':')
        if (separator < 1) invalid()
        const id = decodeURIComponent(value.slice(0, separator).replace(/\+/g, ' '))
        if (clientId !== undefined && clientId !== id) invalid()
        clientId = id
        secret = decodeURIComponent(value.slice(separator + 1).replace(/\+/g, ' '))
        method = 'client_secret_basic'
      } catch {
        invalid()
      }
    }
    if (typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 2048) invalid()
    const client = await resolve(clientId, signal)
    if (method !== (client.tokenEndpointAuthMethod ?? 'none')) invalid()
    if (method === 'none') return
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) invalid()
    const digest = createHash('sha256').update(secret).digest()
    let matched = false
    for (const expected of client.secretHashes ?? []) {
      matched = timingSafeEqual(digest, Buffer.from(expected, 'hex')) || matched
    }
    if (!matched) invalid()
  }
  return { resolve, authenticate, metadataSupported }
}

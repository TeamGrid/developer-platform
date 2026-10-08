import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { withinSignal } from './http.js'
import type { OAuthRoutingDirectory } from './oauthRoutingDirectory.js'
import {
  type FederatedOAuthBrokerCell,
  OAuthBrokerInvalidClientError,
  readOAuthBrokerText,
} from './oauthTokenBroker.js'

const identitySchema = z
  .object({
    issuer: z.string(),
    resource: z.string(),
    region: z.string(),
    cellId: z.string(),
    clientId: z.string().min(1).max(2048),
    clientRecordId: z.string().min(1).max(128),
    subjectId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    scopes: z.array(z.string().min(1).max(128)).min(1).max(100),
    expiresAt: z.iso.datetime(),
    email: z.string().min(3).max(254).optional(),
    emailVerified: z.boolean().optional(),
    nonce: z
      .string()
      .regex(/^[\x20-\x7e]{1,256}$/)
      .optional(),
  })
  .strict()
const headers = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
}
function canonicalHttps(value: string) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.href !== value ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url
  } catch {
    throw new Error('OpenID identity configuration is unavailable.')
  }
}

/** Stable public OIDC subjects are opaque and independent of signing-key rotation.
 * The provider supplies the real account ID; email and workspace never identify it. */
export function createOidcSubject(issuer: string, secret: Uint8Array) {
  if (
    canonicalHttps(issuer).pathname !== '/' ||
    !(secret instanceof Uint8Array) ||
    secret.byteLength < 32 ||
    secret.byteLength > 64
  )
    throw new Error('OpenID subject configuration is unavailable.')
  const key = Buffer.from(secret)
  return (subjectId: string) => {
    if (typeof subjectId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(subjectId))
      throw new Error('OpenID identity is unavailable.')
    return createHmac('sha256', key)
      .update(JSON.stringify([issuer, subjectId]))
      .digest('base64url')
  }
}

/** One strongly resolved cell, fresh regional consent and live client registration.
 * No global email search, token cache, fallback cell or identity from URL hints. */
export type FederatedOidcIdentityOptions = {
  issuer: string
  resource: string
  cells: readonly FederatedOAuthBrokerCell[]
  directory: OAuthRoutingDirectory
  scopes: readonly string[]
  subject(subjectId: string): string
  client(
    clientId: string,
    signal: AbortSignal,
  ): Promise<{ _id: string; clientId: string; status: string }>
  enabled(): boolean
  admit(request: Request): Promise<boolean>
  fetch?: typeof fetch
  now?: () => Date
  requestTimeoutMs?: number
}

export function createFederatedOidcIdentityReader(options: FederatedOidcIdentityOptions) {
  const issuer = canonicalHttps(options.issuer),
    resource = canonicalHttps(options.resource)
  const budget = options.requestTimeoutMs ?? 30000
  if (
    issuer.pathname !== '/' ||
    resource.origin !== issuer.origin ||
    !options.scopes.includes('openid') ||
    !options.scopes.includes('email') ||
    !options.scopes.includes('workspace:read') ||
    options.scopes.length > 100 ||
    new Set(options.scopes).size !== options.scopes.length ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    budget > 30000 ||
    options.cells.length < 1 ||
    options.cells.length > 16
  )
    throw new Error('OpenID identity configuration is unavailable.')
  const cells = new Map(
    options.cells.map((cell) => {
      const provider = canonicalHttps(cell.providerBaseUrl)
      if (
        !/^\/internal\/developer\/oauth\/integrations\/(?!regional\/)[a-z][a-z0-9-]{0,31}\/$/.test(
          provider.pathname,
        ) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.cellId) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.region) ||
        cell.serviceSecret.length < 32 ||
        cell.serviceSecret.length > 256
      )
        throw new Error('OpenID identity configuration is unavailable.')
      return [cell.cellId, { ...cell, userInfoUrl: new URL('userinfo', provider).href }] as const
    }),
  )
  if (
    cells.size !== options.cells.length ||
    new Set([...cells.values()].map((cell) => cell.userInfoUrl)).size !== cells.size
  )
    throw new Error('OpenID identity configuration is unavailable.')
  const allowedScopes = new Set(options.scopes)
  const fetcher = options.fetch ?? fetch
  const failure = (status: number, error: string) =>
    Response.json(
      { error },
      {
        status,
        headers: {
          ...headers,
          ...(status === 401 || status === 403
            ? {
                'WWW-Authenticate': `Bearer realm="TeamGrid UserInfo", error="${error}"`,
              }
            : {}),
        },
      },
    )
  return async (token: string, callerSignal: AbortSignal) => {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(budget)])
    try {
      if (!options.enabled()) return failure(503, 'temporarily_unavailable')
      if (!/^tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/.test(token)) return failure(401, 'invalid_token')
      const cellId = await withinSignal(
        options.directory.resolve(
          'access',
          createHash('sha256').update(token).digest('hex'),
          signal,
        ),
        signal,
      )
      const cell = cellId && cells.get(cellId)
      if (!cell) return failure(401, 'invalid_token')
      const response = await withinSignal(
        fetcher(cell.userInfoUrl, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'X-TeamGrid-OAuth-Service-Authorization': `Bearer ${cell.serviceSecret}`,
          },
          body: JSON.stringify({ access_token: token }),
        }),
        signal,
      )
      if ([400, 401, 403, 404].includes(response.status)) {
        await response.body?.cancel()
        return failure(401, 'invalid_token')
      }
      if (
        response.status !== 200 ||
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
      ) {
        await response.body?.cancel()
        return failure(503, 'temporarily_unavailable')
      }
      const parsed = identitySchema.safeParse(
        JSON.parse(await readOAuthBrokerText(response.body, signal)),
      )
      if (!parsed.success) return failure(503, 'temporarily_unavailable')
      const identity = parsed.data,
        now = options.now?.() ?? new Date()
      if (
        identity.issuer !== issuer.href ||
        identity.resource !== resource.href ||
        identity.cellId !== cell.cellId ||
        identity.region !== cell.region ||
        new Set(identity.scopes).size !== identity.scopes.length ||
        identity.scopes.some((scope) => !allowedScopes.has(scope)) ||
        !identity.scopes.includes('workspace:read') ||
        !Number.isFinite(+now) ||
        Date.parse(identity.expiresAt) <= +now ||
        Date.parse(identity.expiresAt) > +now + 300000
      )
        return failure(401, 'invalid_token')
      if (!identity.scopes.includes('openid')) return failure(403, 'insufficient_scope')
      const client = await withinSignal(options.client(identity.clientId, signal), signal)
      if (
        client.status !== 'active' ||
        client.clientId !== identity.clientId ||
        client._id !== identity.clientRecordId
      )
        return failure(401, 'invalid_token')
      const emailRequested = identity.scopes.includes('email')
      if (
        emailRequested &&
        (identity.emailVerified !== true ||
          !identity.email ||
          !z.email().safeParse(identity.email).success)
      )
        return failure(401, 'invalid_token')
      signal.throwIfAborted()
      const completedAt = options.now?.() ?? new Date()
      if (!Number.isFinite(+completedAt) || Date.parse(identity.expiresAt) <= +completedAt)
        return failure(401, 'invalid_token')
      const subject = options.subject(identity.subjectId)
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(subject)) return failure(503, 'temporarily_unavailable')
      return { ...identity, subject }
    } catch (error) {
      return error instanceof OAuthBrokerInvalidClientError
        ? failure(401, 'invalid_token')
        : failure(503, 'temporarily_unavailable')
    }
  }
}

export function createFederatedOidcUserInfo(options: FederatedOidcIdentityOptions) {
  const readIdentity = createFederatedOidcIdentityReader(options)
  const issuer = canonicalHttps(options.issuer)
  const budget = options.requestTimeoutMs ?? 30000
  const failure = (status: number, error: string) =>
    Response.json(
      { error },
      {
        status,
        headers: {
          ...headers,
          ...([401, 403].includes(status)
            ? { 'WWW-Authenticate': `Bearer realm="TeamGrid UserInfo", error="${error}"` }
            : {}),
        },
      },
    )
  return async (request: Request): Promise<Response> => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(budget)])
    try {
      const url = new URL(request.url)
      if (
        url.origin !== issuer.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (request.headers.has('host') && request.headers.get('host') !== issuer.host)
      ) {
        return failure(421, 'invalid_request')
      }
      if (url.pathname !== '/oauth/userinfo') return failure(404, 'invalid_request')
      if (!options.enabled()) return failure(503, 'temporarily_unavailable')
      if (!(await withinSignal(options.admit(request), signal))) {
        return new Response(null, { status: 429, headers: { ...headers, 'Retry-After': '60' } })
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      if (!['GET', 'POST'].includes(request.method)) return failure(405, 'invalid_request')
      if (request.body && (await readOAuthBrokerText(request.body, signal))) {
        return failure(400, 'invalid_request')
      }
      const authorization = request.headers.get('authorization')
      if (!authorization || !/^Bearer tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/.test(authorization)) {
        return failure(401, 'invalid_token')
      }
      const identity = await readIdentity(authorization.slice(7), signal)
      if (identity instanceof Response) return identity
      return Response.json(
        {
          sub: identity.subject,
          ...(identity.scopes.includes('email')
            ? { email: identity.email, email_verified: true }
            : {}),
        },
        { headers },
      )
    } catch {
      return failure(503, 'temporarily_unavailable')
    }
  }
}

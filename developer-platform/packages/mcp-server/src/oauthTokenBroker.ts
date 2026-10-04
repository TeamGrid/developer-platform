import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { withinSignal } from './http.js'
import { type OAuthRoutingDirectory, oauthRoutingRecordSchema } from './oauthRoutingDirectory.js'

const tokenSchema = z
  .object({
    access_token: z.string().regex(/^tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/),
    refresh_token: z.string().regex(/^tg_mcp_rt_v1_[A-Za-z0-9_-]{43}$/),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().min(1).max(300),
    scope: z.string().min(1).max(4096),
  })
  .strict()
const wireRoute = oauthRoutingRecordSchema.extend({
  createdAt: z.iso.datetime().transform((value) => new Date(value)),
  expiresAt: z.iso.datetime().transform((value) => new Date(value)),
})
const resultSchema = z
  .object({ tokenResponse: tokenSchema, routes: z.array(wireRoute).length(2) })
  .strict()
const errors = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'invalid_scope',
  'unsupported_grant_type',
  'invalid_target',
])
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const headers = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
}

export type FederatedOAuthBrokerCell = {
  cellId: string
  region: string
  /** Exact operator-owned private integration base, ending in /<id>/. */
  providerBaseUrl: string
  serviceSecret: string
}

export class OAuthBrokerInvalidClientError extends Error {
  constructor() {
    super('Invalid OAuth client.')
  }
}
class OAuthBodyTooLargeError extends Error {}

async function boundedText(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  const reader = body?.getReader()
  if (!reader) throw new Error('Provider unavailable.')
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await withinSignal(reader.read(), signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 16384) {
        cancel()
        throw new OAuthBodyTooLargeError('OAuth body too large.')
      }
      chunks.push(chunk.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(
    await boundedText(response.body, AbortSignal.any([signal, AbortSignal.timeout(5000)])),
  )
}

/** Public token/revoke channel. Authorization, consent/resume and discovery are separate wiring. */
export function createFederatedOAuthTokenBroker(options: {
  issuer: string
  resource: string
  cells: readonly FederatedOAuthBrokerCell[]
  directory: OAuthRoutingDirectory
  enabled(): boolean
  admit(request: Request): Promise<boolean>
  /** Global registry/CIMD policy must authenticate before looking up an opaque credential. */
  authenticateClient(
    parameters: Readonly<Record<string, string>>,
    authorization: string | null,
    signal: AbortSignal,
  ): Promise<void>
  scopes: readonly string[]
  fetch?: typeof fetch
  requestTimeoutMs?: number
}) {
  const issuer = new URL(options.issuer)
  const resource = new URL(options.resource)
  const canonical = (url: URL, value: string) =>
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.href === value
  if (
    !canonical(issuer, options.issuer) ||
    issuer.pathname !== '/' ||
    !canonical(resource, options.resource) ||
    options.cells.length < 1 ||
    options.cells.length > 16 ||
    !options.scopes.includes('workspace:read')
  ) {
    throw new Error('Invalid federated OAuth broker configuration.')
  }
  const timeout = options.requestTimeoutMs ?? 30000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) {
    throw new Error('Invalid federated OAuth request deadline.')
  }
  const scopes = new Set(options.scopes)
  const cells = new Map(
    options.cells.map((value) => {
      const cell = { ...value }
      const url = new URL(cell.providerBaseUrl)
      if (
        !canonical(url, cell.providerBaseUrl) ||
        !/^\/internal\/developer\/oauth\/integrations\/(?!regional\/)[a-z][a-z0-9-]{0,31}\/$/.test(
          url.pathname,
        ) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.cellId) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.region) ||
        cell.serviceSecret.length < 32 ||
        cell.serviceSecret.length > 256 ||
        Object.keys(cell).some(
          (key) => !['cellId', 'region', 'providerBaseUrl', 'serviceSecret'].includes(key),
        )
      ) {
        throw new Error('Invalid federated OAuth provider.')
      }
      return [cell.cellId, cell] as const
    }),
  )
  if (
    cells.size !== options.cells.length ||
    new Set([...cells.values()].map((cell) => cell.providerBaseUrl)).size !== cells.size
  ) {
    throw new Error('Duplicate federated OAuth provider.')
  }
  const fetcher = options.fetch ?? fetch
  const json = (status: number, error: string) =>
    Response.json(
      { error },
      {
        status,
        headers: {
          ...headers,
          ...(status === 401 && error === 'invalid_client'
            ? { 'WWW-Authenticate': 'Basic realm="TeamGrid OAuth"' }
            : {}),
        },
      },
    )
  const providerError = (response: Response, value: unknown) => {
    if (response.status === 429)
      return Response.json(
        { error: 'temporarily_unavailable' },
        {
          status: 429,
          headers: { ...headers, 'Retry-After': '60' },
        },
      )
    const error = z.object({ error: z.string() }).safeParse(value)
    if (response.status < 500 && error.success && error.data.error === 'access_denied') {
      return json(400, 'invalid_grant')
    }
    return response.status < 500 && error.success && errors.has(error.data.error)
      ? json(response.status === 401 ? 401 : 400, error.data.error)
      : json(503, 'temporarily_unavailable')
  }
  return async (request: Request): Promise<Response> => {
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)])
    try {
      const url = new URL(request.url)
      if (
        url.origin !== issuer.origin ||
        url.username ||
        url.password ||
        url.search ||
        (request.headers.has('host') && request.headers.get('host') !== issuer.host)
      ) {
        return json(421, 'invalid_request')
      }
      if (!['/oauth/token', '/oauth/revoke'].includes(url.pathname))
        return json(404, 'invalid_request')
      if (!options.enabled()) return json(503, 'temporarily_unavailable')
      if (!(await withinSignal(options.admit(request), deadline))) {
        return Response.json(
          { error: 'temporarily_unavailable' },
          {
            status: 429,
            headers: { ...headers, 'Retry-After': '60' },
          },
        )
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      if (request.method !== 'POST') return json(405, 'invalid_request')
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/x-www-form-urlencoded'
      )
        return json(415, 'invalid_request')
      if (!request.body) return json(400, 'invalid_request')
      let text: string
      try {
        text = await boundedText(request.body, deadline)
      } catch (error) {
        if (error instanceof OAuthBodyTooLargeError) return json(413, 'invalid_request')
        if (error instanceof TypeError && !deadline.aborted) return json(400, 'invalid_request')
        throw error
      }
      const parameters: Record<string, string> = Object.create(null)
      for (const [key, value] of new URLSearchParams(text)) {
        if (Object.hasOwn(parameters, key)) return json(400, 'invalid_request')
        parameters[key] = value
      }
      const authorization = request.headers.get('authorization')
      if (
        (authorization && (authorization.length > 4096 || !/^Basic \S+$/i.test(authorization))) ||
        request.headers.has('X-TeamGrid-OAuth-Service-Authorization') ||
        request.headers.has('X-TeamGrid-OAuth-Exchange-ID')
      )
        return json(400, 'invalid_request')
      const revoke = url.pathname === '/oauth/revoke'
      const kind = revoke
        ? parameters.token?.startsWith('tg_mcp_rt_v1_')
          ? 'refresh'
          : 'access'
        : parameters.grant_type === 'authorization_code'
          ? 'code'
          : 'refresh'
      const allowed = revoke
        ? ['client_id', 'client_secret', 'token', 'token_type_hint']
        : kind === 'code'
          ? [
              'grant_type',
              'client_id',
              'client_secret',
              'code',
              'code_verifier',
              'redirect_uri',
              'resource',
            ]
          : ['grant_type', 'client_id', 'client_secret', 'refresh_token', 'resource', 'scope']
      if (Object.keys(parameters).some((key) => !allowed.includes(key)))
        return json(400, 'invalid_request')
      if (
        !revoke &&
        !['authorization_code', 'refresh_token'].includes(parameters.grant_type ?? '')
      ) {
        return json(400, 'unsupported_grant_type')
      }
      if (!revoke && parameters.resource !== resource.href) return json(400, 'invalid_target')
      try {
        await withinSignal(
          options.authenticateClient(Object.freeze({ ...parameters }), authorization, deadline),
          deadline,
        )
      } catch (error) {
        if (!(error instanceof OAuthBrokerInvalidClientError)) throw error
        return Response.json(
          { error: 'invalid_client' },
          {
            status: authorization ? 401 : 400,
            headers: {
              ...headers,
              ...(authorization ? { 'WWW-Authenticate': 'Basic realm="TeamGrid OAuth"' } : {}),
            },
          },
        )
      }
      const credential = revoke
        ? parameters.token
        : kind === 'code'
          ? parameters.code
          : parameters.refresh_token
      const pattern =
        kind === 'code'
          ? /^[A-Za-z0-9_-]{43}$/
          : kind === 'access'
            ? /^tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/
            : /^tg_mcp_rt_v1_[A-Za-z0-9_-]{43}$/
      if (!credential || credential.length > 256) return json(400, 'invalid_request')
      if (!pattern.test(credential))
        return revoke ? new Response(null, { status: 200, headers }) : json(400, 'invalid_grant')
      const cellId = await withinSignal(
        options.directory.resolve(kind, digest(credential), deadline),
        deadline,
      )
      if (cellId === null)
        return revoke ? new Response(null, { status: 200, headers }) : json(400, 'invalid_grant')
      const cell = cells.get(cellId)
      if (!cell) throw new Error('Unknown regional route.')
      const operationId = randomBytes(32).toString('base64url')
      const provider = async (operation: 'token' | 'recover' | 'revoke') => {
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(5000)])
        return withinSignal(
          fetcher(new URL(operation, cell.providerBaseUrl), {
            method: 'POST',
            signal,
            redirect: 'error',
            credentials: 'omit',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-TeamGrid-OAuth-Service-Authorization': `Bearer ${cell.serviceSecret}`,
              ...(!revoke ? { 'X-TeamGrid-OAuth-Exchange-ID': operationId } : {}),
              ...(authorization ? { Authorization: authorization } : {}),
            },
            body: text,
          }),
          signal,
        )
      }
      if (revoke) {
        const response = await provider('revoke')
        if (response.status === 200) return new Response(null, { status: 200, headers })
        return providerError(response, await boundedJson(response, deadline))
      }
      let response: Response
      let value: unknown
      let recovered = false
      try {
        response = await provider('token')
        value = await boundedJson(response, deadline)
      } catch {
        recovered = true
        response = await provider('recover')
        value = await boundedJson(response, deadline)
      }
      if (response.status === 503 && !recovered) {
        response = await provider('recover')
        value = await boundedJson(response, deadline)
      }
      if (!response.ok) {
        return providerError(response, value)
      }
      const result = resultSchema.parse(value)
      const grantedScopes = result.tokenResponse.scope.split(' ')
      if (
        !grantedScopes.includes('workspace:read') ||
        grantedScopes.some((scope) => !scopes.has(scope)) ||
        new Set(result.routes.map((route) => route.kind)).size !== 2 ||
        result.routes.some(
          (route) =>
            !['access', 'refresh'].includes(route.kind) ||
            route.issuer !== issuer.href ||
            route.resource !== resource.href ||
            route.cellId !== cell.cellId ||
            route.region !== cell.region ||
            route.hash !==
              digest(
                route.kind === 'access'
                  ? result.tokenResponse.access_token
                  : result.tokenResponse.refresh_token,
              ),
        ) ||
        result.routes[0]?.registrationId !== result.routes[1]?.registrationId
      ) {
        throw new Error('Invalid provider publication.')
      }
      await withinSignal(options.directory.register(result.routes, deadline), deadline)
      return Response.json(result.tokenResponse, { status: 200, headers })
    } catch {
      return json(503, 'temporarily_unavailable')
    }
  }
}

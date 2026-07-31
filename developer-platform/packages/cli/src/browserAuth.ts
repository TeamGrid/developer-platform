import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { platform as nodePlatform } from 'node:os'
import {
  buildRegionalApiBaseUrl,
  parseCredentialLocation,
  TeamGridClientError,
} from '@teamgrid/api-client'

export const cliAuthorizationClientId = 'teamgrid-cli'
export const defaultCliAuthorizationPageUrl = 'https://login.teamgrid.app/developer/cli/authorize'
export const defaultBrowserAuthorizationTimeoutMs = 10 * 60 * 1000

const maximumResponseBytes = 64 * 1024
const base64UrlPattern = /^[A-Za-z0-9_-]+$/
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/
const scopePattern = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){1,2}$/

const readOnlyScopes = Object.freeze([
  'workspace:read',
  'projects:read',
  'tasks:read',
  'time-entries:read',
])

const dailyWorkScopes = Object.freeze([
  'workspace:read',
  'projects:read',
  'tasks:read',
  'tasks:write',
  'time-entries:read',
  'time-entries:write',
  'activity:read',
  'comments:read',
  'comments:write',
])

export const sensitiveBrowserAuthorizationScopes = Object.freeze([
  'absences:admin:write',
  'absences:delegated:read',
  'appointments:delegated:read',
  'appointments:delegated:write',
  'audit:read',
  'automations:read',
  'automations:run',
  'automations:write',
  'availability:delegated:read',
  'changes:read',
  'credentials:read',
  'credentials:write',
  'exports:read',
  'exports:write',
  'groups:read',
  'groups:write',
  'integrations:read',
  'invitations:read',
  'invitations:write',
  'members:pii:read',
  'members:read',
  'members:write',
  'products:finance:read',
  'products:finance:write',
  'project-statements:finance:read',
  'project-statements:finance:write',
  'projects:sharing',
  'resource-grants:read',
  'resource-grants:write',
  'roles:read',
  'roles:write',
  'service-accounts:read',
  'service-accounts:write',
  'time-entries:billing',
  'webhooks:write',
  'workspace-settings:write',
])

const sensitiveScopeSet = new Set(sensitiveBrowserAuthorizationScopes)

const pairingWords = Object.freeze([
  'amber',
  'atlas',
  'birch',
  'cobalt',
  'coral',
  'delta',
  'ember',
  'falcon',
  'forest',
  'harbor',
  'indigo',
  'juniper',
  'lagoon',
  'maple',
  'meadow',
  'meteor',
  'ocean',
  'olive',
  'orchid',
  'pebble',
  'quartz',
  'raven',
  'river',
  'saffron',
  'silver',
  'summit',
  'tiger',
  'valley',
  'violet',
  'willow',
  'winter',
  'zephyr',
])

export type CliAuthorizationScopePreset = 'daily-work' | 'read-only'

export type BrowserLoginOptions = {
  apiBaseUrl?: string
  authorizationPageUrl?: string
  cliInstallationId: string
  cliVersion: string
  noBrowser?: boolean
  platform?: NodeJS.Platform
  preset?: CliAuthorizationScopePreset
  scopes?: string[]
  timeoutMs?: number
  writeStatus: (message: string) => void
}

export type BrowserLoginResult = {
  accessToken: string
  cellId: string
  credentialId: string
  expiresAt: string
  grantId: string
  region: string
  replayed: boolean
  scopes: string[]
}

type BrowserCallback = {
  authorizationCode: string
  cellId: string
  region: string
}

type BrowserAuthDependencies = {
  fetch: typeof globalThis.fetch
  now?: () => Date
  openBrowser: (url: string, platform: NodeJS.Platform) => Promise<void>
  randomBytes: (size: number) => Buffer
  startCallbackServer: (
    state: string,
    callbackPath: string,
    timeoutMs: number,
  ) => Promise<{
    callback: Promise<BrowserCallback>
    close: () => Promise<void>
    redirectUri: string
  }>
}

function invalid(code: string, message: string, cause?: unknown): never {
  throw new TeamGridClientError(code, message, cause ? { cause } : undefined)
}

function base64Url(value: Buffer) {
  return value.toString('base64url')
}

function opaqueValue(randomBytes: (size: number) => Buffer, size = 32) {
  const value = randomBytes(size)
  if (!Buffer.isBuffer(value) || value.length !== size) {
    return invalid(
      'browser_authorization_unavailable',
      'Secure randomness is unavailable for browser authorization.',
    )
  }
  return base64Url(value)
}

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function exactValue(parameters: URLSearchParams, name: string) {
  const values = parameters.getAll(name)
  return values.length === 1 ? values[0] || '' : ''
}

function normalizeAuthorizationPageUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    return invalid(
      'invalid_authorization_url',
      'The TeamGrid browser authorization URL is invalid.',
      error,
    )
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''))
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalid(
      'invalid_authorization_url',
      'The TeamGrid browser authorization URL must be credential-free HTTPS.',
    )
  }
  return url
}

export function normalizeBrowserAuthorizationScopes({
  preset = 'read-only',
  scopes,
}: {
  preset?: CliAuthorizationScopePreset
  scopes?: string[]
}) {
  const values = scopes?.length
    ? scopes
    : preset === 'daily-work'
      ? dailyWorkScopes
      : preset === 'read-only'
        ? readOnlyScopes
        : []
  const normalized = Array.from(new Set(values))
  if (
    normalized.length < 1 ||
    normalized.length > 100 ||
    normalized.some((scope) => !scopePattern.test(scope))
  ) {
    return invalid(
      'invalid_arguments',
      'Browser login requires 1–100 unique valid TeamGrid scopes.',
    )
  }
  const sensitive = normalized.filter((scope) => sensitiveScopeSet.has(scope))
  if (sensitive.length > 0) {
    return invalid(
      'browser_sensitive_scopes_unavailable',
      `Browser login cannot request sensitive scopes yet (${sensitive.join(', ')}). ` +
        'Create a narrowly scoped personal credential in the TeamGrid Developer Center and use ' +
        "'teamgrid auth login --manual' instead.",
    )
  }
  return normalized
}

function pairingPhrase(randomBytes: (size: number) => Buffer) {
  const entropy = randomBytes(3)
  if (!Buffer.isBuffer(entropy) || entropy.length !== 3) {
    return invalid(
      'browser_authorization_unavailable',
      'Secure randomness is unavailable for browser authorization.',
    )
  }
  return Array.from(entropy, (value) => pairingWords[value % pairingWords.length]).join(' ')
}

function browserAuthorizationUrl({
  authorizationPageUrl,
  authorizationRequestId,
  challenge,
  cliInstallationId,
  cliVersion,
  pairing,
  platform,
  redirectUri,
  requestSecret,
  scopes,
  state,
}: {
  authorizationPageUrl: string
  authorizationRequestId: string
  challenge: string
  cliInstallationId: string
  cliVersion: string
  pairing: string
  platform: NodeJS.Platform
  redirectUri: string
  requestSecret: string
  scopes: string[]
  state: string
}) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    return invalid('unsupported_platform', `Browser login is not supported on ${platform}.`)
  }
  const url = normalizeAuthorizationPageUrl(authorizationPageUrl)
  const fragment = new URLSearchParams()
  fragment.set('authorization_request_id', authorizationRequestId)
  fragment.set('cli_installation_id', cliInstallationId)
  fragment.set('cli_version', cliVersion)
  fragment.set('code_challenge', challenge)
  fragment.set('pairing_phrase', pairing)
  fragment.set('platform', platform)
  fragment.set('redirect_uri', redirectUri)
  fragment.set('request_secret', requestSecret)
  fragment.set('state', state)
  scopes.forEach((scope) => {
    fragment.append('scope', scope)
  })
  url.hash = fragment.toString()
  return url.toString()
}

function safeCallbackHtml(title: string, message: string) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title></head>`,
    '<body style="font-family:system-ui,sans-serif;max-width:560px;',
    'margin:80px auto;padding:0 24px;color:#232733">',
    `<h1 style="font-size:28px">${title}</h1><p>${message}</p></body></html>`,
  ].join('')
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

export async function startCliBrowserCallbackServer(
  state: string,
  callbackPath: string,
  timeoutMs = defaultBrowserAuthorizationTimeoutMs,
) {
  if (
    !base64UrlPattern.test(state) ||
    state.length < 22 ||
    !/^\/teamgrid\/callback\/[A-Za-z0-9_-]{22,86}$/.test(callbackPath) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > defaultBrowserAuthorizationTimeoutMs
  ) {
    return invalid(
      'invalid_arguments',
      'The browser authorization callback configuration is invalid.',
    )
  }

  let resolveCallback: (value: BrowserCallback) => void = () => undefined
  let rejectCallback: (error: Error) => void = () => undefined
  let settled = false
  let expectedHost = ''
  const callback = new Promise<BrowserCallback>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  const server = createServer((request, response) => {
    const fail = (status: number, message: string) => {
      response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
      })
      response.end(safeCallbackHtml('TeamGrid CLI', message))
    }
    if (settled) {
      fail(409, 'This authorization request has already been completed.')
      return
    }
    if (request.method !== 'GET' || request.headers.host !== expectedHost || !request.url) {
      fail(400, 'The callback request is invalid.')
      return
    }
    const callbackUrl = new URL(request.url, `http://${expectedHost}`)
    if (callbackUrl.pathname !== callbackPath) {
      fail(404, 'This callback path is not available.')
      return
    }
    const fields: string[] = []
    callbackUrl.searchParams.forEach((_value, field) => {
      fields.push(field)
    })
    const authorizationCode = exactValue(callbackUrl.searchParams, 'code')
    const returnedState = exactValue(callbackUrl.searchParams, 'state')
    const region = exactValue(callbackUrl.searchParams, 'region')
    const cellId = exactValue(callbackUrl.searchParams, 'cell_id')
    if (
      fields.length !== 4 ||
      fields.some((field) => !['cell_id', 'code', 'region', 'state'].includes(field)) ||
      returnedState !== state ||
      !base64UrlPattern.test(authorizationCode) ||
      authorizationCode.length < 43 ||
      authorizationCode.length > 172 ||
      !identifierPattern.test(region) ||
      !identifierPattern.test(cellId)
    ) {
      fail(400, 'The callback request could not be verified.')
      return
    }
    settled = true
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
    })
    response.end(
      safeCallbackHtml(
        'TeamGrid CLI is connected',
        'You can close this page and return to your terminal.',
      ),
    )
    resolveCallback({ authorizationCode, cellId, region })
  })

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string' || address.port < 1024) {
    await closeServer(server)
    return invalid(
      'browser_authorization_unavailable',
      'The CLI could not allocate a secure loopback callback.',
    )
  }
  expectedHost = `127.0.0.1:${address.port}`
  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCallback(
      new TeamGridClientError(
        'browser_authorization_timeout',
        'Browser authorization expired. Run teamgrid auth login again.',
      ),
    )
  }, timeoutMs)
  timeout.unref()

  return {
    callback,
    close: async () => {
      clearTimeout(timeout)
      await closeServer(server)
    },
    redirectUri: `http://${expectedHost}${callbackPath}`,
  }
}

function spawnBrowser(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = nodeSpawn(command, args, {
      detached: false,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Browser opener exited with status ${code ?? 'unknown'}.`))
    })
  })
}

export function openSystemBrowser(url: string, platform = nodePlatform()) {
  normalizeAuthorizationPageUrl(url.split('#', 1)[0] || '')
  if (platform === 'darwin') return spawnBrowser('open', [url])
  if (platform === 'linux') return spawnBrowser('xdg-open', [url])
  if (platform === 'win32') {
    return spawnBrowser('rundll32.exe', ['url.dll,FileProtocolHandler', url])
  }
  return invalid('unsupported_platform', `Browser login is not supported on ${platform}.`)
}

function tokenExchangeUrl(apiBaseUrl: string | undefined, region: string) {
  const baseUrl = apiBaseUrl || buildRegionalApiBaseUrl(region)
  return `${baseUrl.replace(/\/+$/, '')}/auth/cli/token`
}

async function exchangeAuthorizationCode({
  apiBaseUrl,
  authorizationCode,
  cellId,
  codeVerifier,
  fetch,
  redirectUri,
  region,
  requestedScopes,
  now,
}: BrowserCallback & {
  apiBaseUrl?: string
  codeVerifier: string
  fetch: typeof globalThis.fetch
  now: Date
  redirectUri: string
  requestedScopes: string[]
}) {
  let response: Response
  try {
    response = await fetch(tokenExchangeUrl(apiBaseUrl, region), {
      body: JSON.stringify({
        authorizationCode,
        clientId: cliAuthorizationClientId,
        codeVerifier,
        grantType: 'authorization_code',
        redirectUri,
      }),
      cache: 'no-store',
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/json',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return invalid(
      'network_error',
      'The CLI could not exchange the browser authorization code.',
      error,
    )
  }
  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  if (body.length > maximumResponseBytes) {
    return invalid('invalid_api_response', 'The TeamGrid authorization response is too large.')
  }
  let document: unknown
  try {
    document = JSON.parse(body)
  } catch (error) {
    return invalid('invalid_api_response', 'The TeamGrid authorization response is invalid.', error)
  }
  if (!response.ok) {
    const errorDocument = document as {
      errors?: Array<{ detail?: unknown }>
    }
    const detail = errorDocument.errors?.[0]?.detail
    return invalid(
      response.status === 400 ? 'invalid_grant' : 'authorization_exchange_failed',
      typeof detail === 'string' && detail.length <= 300
        ? detail
        : 'The TeamGrid authorization code could not be exchanged.',
    )
  }
  if (!/^application\/(?:vnd\.api\+)?json\b/i.test(contentType)) {
    return invalid(
      'invalid_api_response',
      'The TeamGrid authorization response has an invalid content type.',
    )
  }
  const resource = (
    document as {
      data?: {
        attributes?: Record<string, unknown>
        id?: unknown
        type?: unknown
      }
    }
  ).data
  const attributes = resource?.attributes
  if (
    resource?.type !== 'cliAuthorization' ||
    typeof resource.id !== 'string' ||
    !attributes ||
    typeof attributes.accessToken !== 'string' ||
    typeof attributes.cellId !== 'string' ||
    typeof attributes.expiresAt !== 'string' ||
    typeof attributes.grantId !== 'string' ||
    !identifierPattern.test(attributes.grantId) ||
    typeof attributes.region !== 'string' ||
    typeof attributes.replayed !== 'boolean' ||
    attributes.tokenType !== 'Bearer' ||
    !Array.isArray(attributes.scopes) ||
    attributes.scopes.length < 1 ||
    attributes.scopes.length > 100 ||
    attributes.scopes.some((scope) => typeof scope !== 'string' || !scopePattern.test(scope)) ||
    attributes.cellId !== cellId ||
    attributes.region !== region ||
    !Number.isFinite(Date.parse(attributes.expiresAt)) ||
    Date.parse(attributes.expiresAt) <= now.getTime() ||
    new Set(attributes.scopes).size !== attributes.scopes.length ||
    JSON.stringify([...attributes.scopes].sort()) !== JSON.stringify([...requestedScopes].sort())
  ) {
    return invalid('invalid_api_response', 'The TeamGrid authorization response is invalid.')
  }
  const location = parseCredentialLocation(attributes.accessToken)
  if (
    location.cellId !== cellId ||
    location.region !== region ||
    location.credentialId !== resource.id
  ) {
    return invalid(
      'invalid_api_response',
      'The TeamGrid credential location does not match the authorization response.',
    )
  }
  return Object.freeze({
    accessToken: attributes.accessToken,
    cellId,
    credentialId: location.credentialId,
    expiresAt: attributes.expiresAt,
    grantId: attributes.grantId,
    region,
    replayed: attributes.replayed,
    scopes: attributes.scopes as string[],
  })
}

const defaultDependencies: BrowserAuthDependencies = {
  fetch: globalThis.fetch,
  openBrowser: openSystemBrowser,
  randomBytes: nodeRandomBytes,
  startCallbackServer: startCliBrowserCallbackServer,
}

export async function loginWithSystemBrowser(
  options: BrowserLoginOptions,
  dependencies: BrowserAuthDependencies = defaultDependencies,
): Promise<BrowserLoginResult> {
  if (!base64UrlPattern.test(options.cliInstallationId)) {
    return invalid('invalid_config', 'The CLI installation identifier is invalid.')
  }
  const platform = options.platform || nodePlatform()
  const state = opaqueValue(dependencies.randomBytes)
  const requestSecret = opaqueValue(dependencies.randomBytes)
  const authorizationRequestId = opaqueValue(dependencies.randomBytes)
  const codeVerifier = opaqueValue(dependencies.randomBytes, 48)
  const callbackPath = `/teamgrid/callback/${opaqueValue(dependencies.randomBytes, 16)}`
  const pairing = pairingPhrase(dependencies.randomBytes)
  const scopes = normalizeBrowserAuthorizationScopes({
    preset: options.preset,
    scopes: options.scopes,
  })
  const callbackServer = await dependencies.startCallbackServer(
    state,
    callbackPath,
    options.timeoutMs || defaultBrowserAuthorizationTimeoutMs,
  )
  try {
    const authorizationUrl = browserAuthorizationUrl({
      authorizationPageUrl: options.authorizationPageUrl || defaultCliAuthorizationPageUrl,
      authorizationRequestId,
      challenge: pkceChallenge(codeVerifier),
      cliInstallationId: options.cliInstallationId,
      cliVersion: options.cliVersion,
      pairing,
      platform,
      redirectUri: callbackServer.redirectUri,
      requestSecret,
      scopes,
      state,
    })
    options.writeStatus(`Pairing phrase: ${pairing}`)
    if (options.noBrowser) {
      options.writeStatus(`Open this URL in your browser:\n${authorizationUrl}`)
    } else {
      options.writeStatus('Opening TeamGrid in your browser…')
      try {
        await dependencies.openBrowser(authorizationUrl, platform)
      } catch {
        options.writeStatus(`The browser could not be opened automatically.\n${authorizationUrl}`)
      }
    }
    const callback = await callbackServer.callback
    return await exchangeAuthorizationCode({
      ...callback,
      apiBaseUrl: options.apiBaseUrl,
      codeVerifier,
      fetch: dependencies.fetch,
      now: dependencies.now?.() || new Date(),
      redirectUri: callbackServer.redirectUri,
      requestedScopes: scopes,
    })
  } finally {
    await callbackServer.close()
  }
}

export function createCliInstallationId(randomBytes: (size: number) => Buffer = nodeRandomBytes) {
  return opaqueValue(randomBytes)
}

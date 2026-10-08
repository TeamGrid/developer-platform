import { createHash, createPrivateKey, createPublicKey, type JsonWebKey, sign } from 'node:crypto'

type PublicSigningKey = { kty: 'RSA'; n: string; e: string; kid: string; alg: 'RS256'; use: 'sig' }
export type OidcAuthentication = {
  subject: string
  clientId: string
  authenticatedAt: number
  accessExpiresAt: number
  authorizationExpiresAt: number
  nonce?: string
}

const unavailable = () => new Error('OpenID signing configuration is unavailable.')
const invalidAuthentication = () => new Error('OpenID authentication is unavailable.')

function publicKey(value: JsonWebKey): PublicSigningKey {
  if (
    value.kty !== 'RSA' ||
    typeof value.n !== 'string' ||
    typeof value.e !== 'string' ||
    !/^[A-Za-z0-9_-]{342,683}$/.test(value.n) ||
    !/^[A-Za-z0-9_-]{1,16}$/.test(value.e)
  )
    throw unavailable()
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ e: value.e, kty: value.kty, n: value.n }))
    .digest('base64url')
  return { kty: 'RSA', n: value.n, e: value.e, kid: thumbprint, alg: 'RS256', use: 'sig' }
}

/** Identity assertions only. These JWTs are never MCP/API bearer credentials.
 * The caller must first validate the current client, grant, session and consent.
 * All times are Unix seconds from that fresh, trusted authorization snapshot. */
export function createOidcSigner(options: {
  issuer: string
  privateKeyPem: string
  previousPublicKeys?: readonly JsonWebKey[]
  now?: () => number
}) {
  let issuer: URL
  try {
    issuer = new URL(options.issuer)
    if (
      issuer.protocol !== 'https:' ||
      issuer.pathname !== '/' ||
      issuer.href !== options.issuer ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      typeof options.privateKeyPem !== 'string' ||
      options.privateKeyPem.length > 16384 ||
      !options.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----') ||
      (options.previousPublicKeys?.length ?? 0) > 2
    )
      throw unavailable()
  } catch {
    throw unavailable()
  }
  let key: ReturnType<typeof createPrivateKey>
  let current: PublicSigningKey
  let previous: PublicSigningKey[]
  try {
    key = createPrivateKey(options.privateKeyPem)
    if (
      key.asymmetricKeyType !== 'rsa' ||
      !Number.isSafeInteger(key.asymmetricKeyDetails?.modulusLength) ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) > 4096
    )
      throw unavailable()
    current = publicKey(createPublicKey(key).export({ format: 'jwk' }))
    previous = (options.previousPublicKeys ?? []).map((value) => {
      if (
        Object.keys(value).some((field) => !['kty', 'n', 'e', 'kid', 'alg', 'use'].includes(field))
      )
        throw unavailable()
      publicKey(value)
      if (
        (value.alg !== undefined && value.alg !== 'RS256') ||
        (value.use !== undefined && value.use !== 'sig')
      )
        throw unavailable()
      const imported = createPublicKey({ key: value, format: 'jwk' })
      if (
        imported.asymmetricKeyType !== 'rsa' ||
        (imported.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        (imported.asymmetricKeyDetails?.modulusLength ?? 0) > 4096
      )
        throw unavailable()
      const projection = publicKey(imported.export({ format: 'jwk' }))
      if (value.kid !== undefined && value.kid !== projection.kid) throw unavailable()
      return projection
    })
    if (new Set([current.kid, ...previous.map((value) => value.kid)]).size !== previous.length + 1)
      throw unavailable()
  } catch {
    throw unavailable()
  }
  const keys = [current, ...previous]
  return {
    jwks: () => ({ keys: keys.map((value) => ({ ...value })) }),
    sign(authentication: OidcAuthentication): string {
      const now = Math.floor(options.now?.() ?? Date.now() / 1000)
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Object.keys(authentication).some(
          (field) =>
            ![
              'subject',
              'clientId',
              'authenticatedAt',
              'accessExpiresAt',
              'authorizationExpiresAt',
              'nonce',
            ].includes(field),
        ) ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        typeof authentication.subject !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(authentication.subject) ||
        typeof authentication.clientId !== 'string' ||
        authentication.clientId.length < 1 ||
        authentication.clientId.length > 2048 ||
        Array.from(authentication.clientId).some(
          (character) => character < ' ' || character === '\u007f',
        ) ||
        !Number.isSafeInteger(authentication.authenticatedAt) ||
        authentication.authenticatedAt < 0 ||
        authentication.authenticatedAt > now ||
        !Number.isSafeInteger(authentication.accessExpiresAt) ||
        !Number.isSafeInteger(authentication.authorizationExpiresAt) ||
        (authentication.nonce !== undefined &&
          (typeof authentication.nonce !== 'string' ||
            !/^[\x20-\x7e]{1,256}$/.test(authentication.nonce)))
      )
        throw invalidAuthentication()
      const expiresAt = Math.min(
        now + 300,
        authentication.accessExpiresAt,
        authentication.authorizationExpiresAt,
      )
      if (expiresAt <= now) throw invalidAuthentication()
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const header = encode({ alg: 'RS256', kid: current.kid, typ: 'JWT' })
      const payload = encode({
        iss: issuer.href,
        sub: authentication.subject,
        aud: authentication.clientId,
        iat: now,
        exp: expiresAt,
        auth_time: authentication.authenticatedAt,
        ...(authentication.nonce === undefined ? {} : { nonce: authentication.nonce }),
      })
      const input = `${header}.${payload}`
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
    },
  }
}

import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createOidcSigner, type OidcAuthentication } from './oidcSigning.js'

// Ephemeral test keys only; no fixture credential or signing secret is persisted.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const issuer = 'https://mcp.example.test/'
const now = 1900000000
const authentication: OidcAuthentication = {
  subject: 's'.repeat(43),
  clientId: 'registered-host',
  authenticatedAt: now - 60,
  accessExpiresAt: now + 300,
  authorizationExpiresAt: now + 1800,
  nonce: 'request-nonce',
}
const options = { issuer, privateKeyPem, now: () => now }
const decode = (value: string | undefined) =>
  JSON.parse(Buffer.from(value ?? '', 'base64url').toString())

describe('OpenID identity assertion signing', () => {
  it('uses a verifiable RS256 signature with exact issuer, audience, subject and nonce', () => {
    const signer = createOidcSigner(options)
    const token = signer.sign(authentication)
    const [header, payload, signature] = token.split('.')
    expect(decode(header)).toEqual({ alg: 'RS256', kid: signer.jwks().keys[0]?.kid, typ: 'JWT' })
    expect(decode(payload)).toEqual({
      iss: issuer,
      sub: authentication.subject,
      aud: authentication.clientId,
      iat: now,
      exp: now + 300,
      auth_time: authentication.authenticatedAt,
      nonce: authentication.nonce,
    })
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        pair.publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true)
    expect(token.startsWith('tg_mcp_at_v1_')).toBe(false)
  })

  it('publishes only public signing material and returns independent snapshots', () => {
    const signer = createOidcSigner(options)
    const snapshot = signer.jwks()
    expect(Object.keys(snapshot.keys[0] ?? {}).sort()).toEqual([
      'alg',
      'e',
      'kid',
      'kty',
      'n',
      'use',
    ])
    expect(snapshot.keys[0]?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const imported = createPublicKey({ key: snapshot.keys[0] ?? {}, format: 'jwk' })
    expect(imported.export({ format: 'jwk' }).n).toBe(pair.publicKey.export({ format: 'jwk' }).n)
    snapshot.keys.length = 0
    expect(signer.jwks().keys).toHaveLength(1)
    expect(JSON.stringify(signer.jwks())).not.toContain('PRIVATE KEY')
  })

  it('never extends access or authorization expiry and omits an absent nonce', () => {
    const signer = createOidcSigner(options)
    const { nonce: _, ...withoutNonce } = authentication
    const token = signer.sign({
      ...withoutNonce,
      accessExpiresAt: now + 45,
      authorizationExpiresAt: now + 10,
    })
    expect(decode(token.split('.')[1]).exp).toBe(now + 10)
    expect(decode(token.split('.')[1])).not.toHaveProperty('nonce')
    expect(
      decode(signer.sign({ ...authentication, accessExpiresAt: now + 3600 }).split('.')[1]).exp,
    ).toBe(now + 300)
  })

  it('refuses expired, future, malformed and unsolicited identity fields', () => {
    const signer = createOidcSigner(options)
    const invalid: unknown[] = [
      null,
      {},
      { ...authentication, accessExpiresAt: now },
      { ...authentication, authorizationExpiresAt: now - 1 },
      { ...authentication, authenticatedAt: now + 1 },
      { ...authentication, authenticatedAt: NaN },
      { ...authentication, accessExpiresAt: 1.5 },
      { ...authentication, subject: 'email@example.test' },
      { ...authentication, clientId: 'host\n' },
      { ...authentication, nonce: '' },
      { ...authentication, nonce: '\n' },
      { ...authentication, nonce: 'n'.repeat(257) },
      { ...authentication, password: 'never-reflect-this' },
    ]
    for (const value of invalid)
      expect(() => signer.sign(value as OidcAuthentication)).toThrow(
        'OpenID authentication is unavailable.',
      )
  })

  it('refuses noncanonical issuers and hides key parsing failures', () => {
    for (const value of [
      'http://mcp.example.test/',
      'https://mcp.example.test',
      'https://mcp.example.test/path/',
      'https://user:secret@mcp.example.test/',
      'https://mcp.example.test/?query=secret',
      'not a URL',
    ])
      expect(() => createOidcSigner({ ...options, issuer: value })).toThrow(
        'OpenID signing configuration is unavailable.',
      )
    expect(() => createOidcSigner({ ...options, privateKeyPem: 'synthetic-secret' })).toThrow(
      'OpenID signing configuration is unavailable.',
    )
    expect(() =>
      createOidcSigner({
        ...options,
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nsynthetic-secret',
      }),
    ).toThrow('OpenID signing configuration is unavailable.')
  })

  it('rejects weak RSA and incompatible private key algorithms', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
    const incompatible = generateKeyPairSync('ed25519').privateKey
    for (const key of [weak, incompatible])
      expect(() =>
        createOidcSigner({
          ...options,
          privateKeyPem: key.export({ format: 'pem', type: 'pkcs8' }).toString(),
        }),
      ).toThrow('unavailable')
  })

  it('retains bounded previous public keys for rotation without signing with them', () => {
    const previous = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      format: 'jwk',
    })
    const signer = createOidcSigner({ ...options, previousPublicKeys: [previous] })
    expect(signer.jwks().keys).toHaveLength(2)
    const header = decode(signer.sign(authentication).split('.')[0])
    expect(header.kid).toBe(signer.jwks().keys[0]?.kid)
    expect(header.kid).not.toBe(signer.jwks().keys[1]?.kid)
    expect(() =>
      createOidcSigner({ ...options, previousPublicKeys: [previous, previous, previous] }),
    ).toThrow('unavailable')
    expect(() =>
      createOidcSigner({ ...options, previousPublicKeys: [previous, previous] }),
    ).toThrow('unavailable')
  })

  it('rejects private, duplicate, mislabeled and altered previous key material', () => {
    const publicJwk = pair.publicKey.export({ format: 'jwk' })
    for (const key of [
      publicJwk,
      pair.privateKey.export({ format: 'jwk' }),
      { ...publicJwk, alg: 'HS256' },
      { ...publicJwk, kid: 'not-the-thumbprint' },
      { ...publicJwk, use: 'enc' },
    ])
      expect(() => createOidcSigner({ ...options, previousPublicKeys: [key] })).toThrow(
        'unavailable',
      )
  })
})

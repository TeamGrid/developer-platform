import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { publicOAuthMetadataAddress } from './oauthClientMetadataFetcher.js'
import {
  createOAuthClientRegistry,
  type OAuthClientRegistration,
  oauthClientMetadataUrl,
  parseOAuthClientMetadata,
} from './oauthClientRegistry.js'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'

const id = 'https://host.example.test/client.json'
const origin = 'https://host.example.test'
const signal = () => new AbortController().signal
const document = (clientId = id) => ({
  client_id: clientId,
  client_name: 'Test host',
  redirect_uris: ['https://host.example.test/callback'],
  token_endpoint_auth_method: 'none',
})
const client: OAuthClientRegistration = {
  _id: 'registered-client-0001',
  clientId: 'host1',
  name: 'Test host',
  status: 'active',
  redirectUris: ['https://host.example.test/callback'],
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe('global OAuth client registry', () => {
  it('excludes ambiguous identity, unsafe callbacks and public/private SSRF aliases', () => {
    expect(oauthClientMetadataUrl(id, [origin]).href).toBe(id)
    for (const value of [
      origin,
      `${id}?x=1`,
      `${id}#fragment`,
      `${origin}:444/client.json`,
      'http://host.example.test/client.json',
      'https://user@host.example.test/client.json',
      'https://127.0.0.1/client.json',
      'https://[::1]/client.json',
      'https://evil.test/client.json',
    ]) {
      expect(() => oauthClientMetadataUrl(value, [origin])).toThrow(OAuthBrokerInvalidClientError)
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.64.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2001:db8::1',
      '2002:7f00:1::',
      '3fff::1',
      'malformed',
    ]) {
      expect(publicOAuthMetadataAddress(address)).toBe(false)
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(publicOAuthMetadataAddress(address)).toBe(true)
    }
    for (const patch of [
      { client_id: `${origin}/other.json` },
      { client_name: '' },
      { client_name: 'control\nname' },
      { redirect_uris: ['https://host.example.test/*'] },
      { redirect_uris: ['http://localhost.example.test/callback'] },
      { grant_types: ['client_credentials'] },
      { response_types: ['token'] },
      { token_endpoint_auth_method: 'client_secret_basic' },
    ]) {
      expect(() => parseOAuthClientMetadata(id, { ...document(), ...patch })).toThrow(
        OAuthBrokerInvalidClientError,
      )
    }
  })
  it('retains regional deterministic CIMD identity, supported public auth and native callbacks', () => {
    const metadata = {
      ...document(),
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1:49152/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    }
    const parsed = parseOAuthClientMetadata(id, metadata)
    expect(parsed._id).toBe(`cimd_${digest(id)}`)
    expect(parsed.tokenEndpointAuthMethod).toBe('none')
    expect(parsed.redirectUris).toEqual(metadata.redirect_uris)
    for (const methods of [[], ['none', 'none'], ['private_key_jwt'], ['none', 1], null, 'none']) {
      expect(() =>
        parseOAuthClientMetadata(id, {
          ...metadata,
          token_endpoint_auth_methods_supported: methods,
        }),
      ).toThrow(OAuthBrokerInvalidClientError)
    }
  })
  it('supports public, Basic and POST auth with exact method/identity and bounded rotation keys', async () => {
    const secret = 'secret:ä +'.repeat(8)
    const registrations: OAuthClientRegistration[] = [
      client,
      {
        ...client,
        _id: 'registered-client-basic',
        clientId: 'host: basic',
        tokenEndpointAuthMethod: 'client_secret_basic',
        secretHashes: [digest('old'.repeat(20)), digest(secret)],
      },
      {
        ...client,
        _id: 'registered-client-post',
        clientId: 'host-post',
        tokenEndpointAuthMethod: 'client_secret_post',
        secretHashes: [digest(secret)],
      },
    ]
    const registry = createOAuthClientRegistry({
      registeredClients: () => registrations,
      allowedMetadataOrigins: () => [],
      metadataSupported: () => false,
    })
    const basic = `Basic ${Buffer.from(`${encodeURIComponent('host: basic')}:${encodeURIComponent(secret)}`).toString('base64')}`
    await registry.authenticate({ client_id: 'host1' }, null, signal())
    await registry.authenticate({}, basic, signal())
    await registry.authenticate({ client_id: 'host-post', client_secret: secret }, null, signal())
    for (const [body, header] of [
      [{ client_id: 'host1', client_secret: secret }, null],
      [{ client_id: 'host-post' }, null],
      [{ client_id: 'host-post', client_secret: 'wrong'.repeat(12) }, null],
      [{ client_id: 'host1' }, basic],
      [{ client_secret: secret }, basic],
      [{ client_id: 'host1' }, 'Bearer anything'],
      [{}, 'Basic //8='],
      [{}, `Basic ${Buffer.from('missing-separator').toString('base64')}`],
    ] as [Record<string, string>, string | null][]) {
      await expect(registry.authenticate(body, header, signal())).rejects.toBeInstanceOf(
        OAuthBrokerInvalidClientError,
      )
    }
  })
  it('reads current static revocation before metadata/cache and returns independent records', async () => {
    let values: OAuthClientRegistration[] = [client]
    let fetches = 0
    const registry = createOAuthClientRegistry({
      registeredClients: () => values,
      metadataSupported: () => true,
      allowedMetadataOrigins: () => [origin],
      fetchMetadata: async () => {
        fetches += 1
        return { body: document(), cacheControl: 'max-age=300', age: null }
      },
    })
    const first = await registry.resolve('host1', signal())
    first.name = 'caller change'
    expect((await registry.resolve('host1', signal())).name).toBe(client.name)
    values = [{ ...client, status: 'revoked' }]
    await expect(registry.resolve('host1', signal())).rejects.toBeInstanceOf(
      OAuthBrokerInvalidClientError,
    )
    const dynamic = await registry.resolve(id, signal())
    values = [{ ...dynamic, status: 'revoked' }]
    await expect(registry.resolve(id, signal())).rejects.toBeInstanceOf(
      OAuthBrokerInvalidClientError,
    )
    expect(fetches).toBe(1)
  })
  it('bounds HTTP cache age, checks trust before cache hits and never caches invalid documents', async () => {
    let time = 0,
      fetches = 0,
      origins = [origin],
      control = 'max-age=10',
      age = '3'
    const registry = createOAuthClientRegistry({
      registeredClients: () => [],
      metadataSupported: () => true,
      allowedMetadataOrigins: () => origins,
      now: () => time,
      fetchMetadata: async (url) => {
        fetches += 1
        return { body: document(url.href), cacheControl: control, age }
      },
    })
    await registry.resolve(id, signal())
    time = 6999
    await registry.resolve(id, signal())
    expect(fetches).toBe(1)
    time = 7000
    await registry.resolve(id, signal())
    expect(fetches).toBe(2)
    origins = []
    await expect(registry.resolve(id, signal())).rejects.toThrow()
    expect(fetches).toBe(2)
    origins = [origin]
    for (const [cacheControl, ageValue] of [
      ['no-store, max-age=300', '0'],
      ['max-age=10', 'invalid'],
      ['max-age=10, max-age=20', '0'],
      ['private', '0'],
    ]) {
      control = cacheControl ?? ''
      age = ageValue ?? ''
      time += 300001
      await registry.resolve(id, signal())
      await registry.resolve(id, signal())
    }
    expect(fetches).toBe(10)
    let attempts = 0
    const broken = createOAuthClientRegistry({
      registeredClients: () => [],
      metadataSupported: () => true,
      allowedMetadataOrigins: () => [origin],
      fetchMetadata: async () => ({
        body: ++attempts === 1 ? {} : document(),
        cacheControl: 'max-age=300',
        age: null,
      }),
    })
    await expect(broken.resolve(id, signal())).rejects.toBeInstanceOf(OAuthBrokerInvalidClientError)
    await broken.resolve(id, signal())
    expect(attempts).toBe(2)
  })
  it('coalesces eight bounded metadata reads, fails closed on changed policy and cancels an uncooperative adapter', async () => {
    let finish = () => {},
      origins = [origin],
      fetches = 0
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const registry = createOAuthClientRegistry({
      registeredClients: () => [],
      metadataSupported: () => true,
      allowedMetadataOrigins: () => origins,
      fetchMetadata: async (url) => {
        fetches += 1
        await gate
        return { body: document(url.href), cacheControl: 'no-store', age: null }
      },
    })
    const requests = [
      registry.resolve(id, signal()),
      registry.resolve(id, signal()),
      ...Array.from({ length: 7 }, (_, i) => registry.resolve(`${origin}/${i}.json`, signal())),
    ]
    await expect(registry.resolve(`${origin}/overflow.json`, signal())).rejects.toThrow('capacity')
    expect(fetches).toBe(8)
    origins = []
    finish()
    expect(
      (await Promise.allSettled(requests)).every((result) => result.status === 'rejected'),
    ).toBe(true)
    const stalled = createOAuthClientRegistry({
      registeredClients: () => [],
      metadataSupported: () => true,
      allowedMetadataOrigins: () => [origin],
      fetchMetadata: () => new Promise(() => {}),
    })
    const controller = new AbortController(),
      work = stalled.resolve(id, controller.signal)
    controller.abort()
    await expect(work).rejects.toThrow()
  })
  it('does not return a metadata identity revoked during its fetch', async () => {
    let values: OAuthClientRegistration[] = [],
      finish = () => {}
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const registry = createOAuthClientRegistry({
      registeredClients: () => values,
      allowedMetadataOrigins: () => [origin],
      metadataSupported: () => true,
      fetchMetadata: async () => {
        await gate
        return { body: document(), cacheControl: 'max-age=300', age: null }
      },
    })
    const work = registry.resolve(id, signal())
    values = [{ ...parseOAuthClientMetadata(id, document()), status: 'revoked' }]
    finish()
    await expect(work).rejects.toBeInstanceOf(OAuthBrokerInvalidClientError)
  })
  it('rejects corrupt/duplicate operator configuration without attempting metadata', async () => {
    for (const values of [
      [client, client],
      [{ ...client, secretHashes: [digest('secret')] }],
      [{ ...client, unexpected: true }],
      [{ ...client, redirectUris: ['https://host.example.test/*'] }],
    ]) {
      let fetched = false
      const registry = createOAuthClientRegistry({
        registeredClients: () => values as OAuthClientRegistration[],
        metadataSupported: () => true,
        allowedMetadataOrigins: () => [origin],
        fetchMetadata: async () => {
          fetched = true
          throw new Error()
        },
      })
      await expect(registry.resolve(id, signal())).rejects.toThrow()
      expect(fetched).toBe(false)
    }
  })
})

import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  addresses4: ['1.1.1.1'],
  addresses6: ['2606:4700:4700::1111'],
  dnsError4: '',
  dnsError6: '',
  status: 200,
  headers: { 'content-type': 'application/json' } as Record<string, string>,
  chunks: [Buffer.from('{"client_id":"fixture"}')],
  requests: 0,
  canceled: 0,
  options: undefined as RequestOptions | undefined,
}))
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4() {
      if (state.dnsError4) return Promise.reject({ code: state.dnsError4 })
      return Promise.resolve(state.addresses4)
    }
    resolve6() {
      if (state.dnsError6) return Promise.reject({ code: state.dnsError6 })
      return Promise.resolve(state.addresses6)
    }
    cancel() {
      state.canceled += 1
    }
  },
}))
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    request: (
      _url: URL,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      state.requests += 1
      state.options = options
      const response = new EventEmitter() as IncomingMessage
      Object.assign(response, {
        headers: state.headers,
        statusCode: state.status,
        destroyed: false,
      })
      response.destroy = (error?: Error) => {
        response.destroyed = true
        if (error) queueMicrotask(() => response.emit('error', error))
        return response
      }
      const request = new EventEmitter() as ClientRequest
      request.end = () => {
        queueMicrotask(() => {
          callback(response)
          for (const chunk of state.chunks) {
            if (!response.destroyed) response.emit('data', chunk)
          }
          if (!response.destroyed) response.emit('end')
        })
        return request
      }
      return request
    },
  }
})

import { fetchOAuthClientMetadata } from './oauthClientMetadataFetcher.js'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'

const url = new URL('https://host.example.test/client.json')
const signal = () => new AbortController().signal
beforeEach(() => {
  state.addresses4 = ['1.1.1.1']
  state.addresses6 = ['2606:4700:4700::1111']
  state.dnsError4 = ''
  state.dnsError6 = ''
  state.status = 200
  state.headers = { 'content-type': 'application/json' }
  state.chunks = [Buffer.from('{"client_id":"fixture"}')]
  state.requests = 0
  state.canceled = 0
  state.options = undefined
})
describe('pinned CIMD HTTPS transport', () => {
  it('pins one checked address, retains TLS hostname and disables ambient agents/compression', async () => {
    expect(await fetchOAuthClientMetadata(url, signal())).toEqual({
      body: { client_id: 'fixture' },
      cacheControl: null,
      age: null,
    })
    expect(state.options).toMatchObject({
      method: 'GET',
      agent: false,
      servername: 'host.example.test',
      family: 4,
      maxHeaderSize: 8192,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    })
    const lookup = state.options?.lookup
    if (!lookup) throw new Error('Missing pinned lookup')
    const address = await new Promise((resolve) =>
      lookup('changed.example.test', { all: true }, (error, result) => {
        if (error) throw error
        resolve(result)
      }),
    )
    expect(address).toEqual([{ address: '1.1.1.1', family: 4 }])
    expect(state.canceled).toBe(1)
  })
  it('rejects any private DNS answer, absent/excessive results before HTTP work', async () => {
    for (const [ipv4, ipv6] of [
      [['127.0.0.1'], []],
      [['1.1.1.1'], ['::1']],
      [[], []],
      [Array.from({ length: 33 }, () => '1.1.1.1'), []],
    ] as [string[], string[]][]) {
      state.addresses4 = ipv4
      state.addresses6 = ipv6
      await expect(fetchOAuthClientMetadata(url, signal())).rejects.toThrow()
    }
    expect(state.requests).toBe(0)
  })
  it('rejects redirects, wrong media/encoding, oversized bodies and invalid UTF-8/JSON', async () => {
    const cases = [
      { status: 302 },
      { headers: { 'content-type': 'text/html' } },
      { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
      { chunks: [Buffer.alloc(32769)] },
      { chunks: [Buffer.from([0xff])] },
      { chunks: [Buffer.from('{invalid')] },
    ]
    for (const patch of cases) {
      Object.assign(
        state,
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          chunks: [Buffer.from('{}')],
        },
        patch,
      )
      await expect(fetchOAuthClientMetadata(url, signal())).rejects.toThrow()
    }
  })
  it('distinguishes missing DNS records and invalid documents from DNS/upstream outages', async () => {
    state.dnsError6 = 'ENODATA'
    await expect(fetchOAuthClientMetadata(url, signal())).resolves.toHaveProperty('body')
    state.dnsError4 = 'ENOTFOUND'
    await expect(fetchOAuthClientMetadata(url, signal())).rejects.toBeInstanceOf(
      OAuthBrokerInvalidClientError,
    )
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'ECANCELLED', 'UNKNOWN']) {
      state.dnsError4 = code
      await expect(fetchOAuthClientMetadata(url, signal())).rejects.not.toBeInstanceOf(
        OAuthBrokerInvalidClientError,
      )
    }
    state.dnsError4 = ''
    state.dnsError6 = 'ESERVFAIL'
    await expect(fetchOAuthClientMetadata(url, signal())).rejects.not.toBeInstanceOf(
      OAuthBrokerInvalidClientError,
    )
    state.dnsError6 = ''
    for (const status of [408, 429, 500, 502, 503]) {
      state.status = status
      await expect(fetchOAuthClientMetadata(url, signal())).rejects.not.toBeInstanceOf(
        OAuthBrokerInvalidClientError,
      )
    }
    state.status = 404
    await expect(fetchOAuthClientMetadata(url, signal())).rejects.toBeInstanceOf(
      OAuthBrokerInvalidClientError,
    )
  })
  it('checks an already canceled request before DNS/HTTPS and preserves bounded cache headers', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchOAuthClientMetadata(url, controller.signal)).rejects.toThrow()
    expect(state.requests).toBe(0)
    state.headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'max-age=60',
      age: '5',
    }
    expect(await fetchOAuthClientMetadata(url, signal())).toMatchObject({
      cacheControl: 'max-age=60',
      age: '5',
    })
  })
})

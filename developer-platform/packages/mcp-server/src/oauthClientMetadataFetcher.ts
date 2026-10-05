import { Resolver } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { OAuthMetadataDocument } from './oauthClientRegistry.js'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv4')
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv6')

export function publicOAuthMetadataAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !privateAddresses.check(address, 'ipv4')
  return (
    family === 6 && globalIpv6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6')
  )
}

/** No redirects, compressed bodies, ambient agent/proxy or second DNS lookup. */
export async function fetchOAuthClientMetadata(
  url: URL,
  signal: AbortSignal,
): Promise<OAuthMetadataDocument> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])
  const cancel = () => resolver.cancel()
  deadline.addEventListener('abort', cancel, { once: true })
  try {
    deadline.throwIfAborted()
    const addresses = await Promise.allSettled([
      resolver.resolve4(url.hostname),
      resolver.resolve6(url.hostname),
    ])
    deadline.throwIfAborted()
    // An absent record is a client problem; resolver failures are availability failures.
    if (
      addresses.some(
        (result) =>
          result.status === 'rejected' && !['ENODATA', 'ENOTFOUND'].includes(result.reason?.code),
      )
    )
      throw new Error('OAuth metadata DNS unavailable.')
    const resolved = addresses.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 }))
        : [],
    )
    const selected = resolved[0]
    if (
      !selected ||
      resolved.length > 32 ||
      resolved.some((value) => !publicOAuthMetadataAddress(value.address))
    ) {
      throw new OAuthBrokerInvalidClientError()
    }
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: 'GET',
          signal: deadline,
          agent: false,
          maxHeaderSize: 8192,
          servername: url.hostname,
          family: selected.family,
          lookup: (_hostname, options, done) => {
            if (options.all) done(null, [selected])
            else done(null, selected.address, selected.family)
          },
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
        },
        (response) => {
          if (
            response.statusCode === 408 ||
            response.statusCode === 429 ||
            (response.statusCode !== undefined && response.statusCode >= 500)
          ) {
            response.destroy()
            reject(new Error('OAuth metadata upstream unavailable.'))
            return
          }
          const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
          if (
            response.statusCode !== 200 ||
            type !== 'application/json' ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          ) {
            response.destroy()
            reject(new OAuthBrokerInvalidClientError())
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 32768) response.destroy(new OAuthBrokerInvalidClientError())
            else chunks.push(chunk)
          })
          response.once('error', reject)
          response.once('aborted', () => reject(new Error('OAuth metadata unavailable.')))
          response.once('end', () => {
            try {
              deadline.throwIfAborted()
              resolve({
                body: JSON.parse(
                  new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                ),
                cacheControl: response.headers['cache-control'] ?? null,
                age: response.headers.age ?? null,
              })
            } catch (error) {
              reject(deadline.aborted ? error : new OAuthBrokerInvalidClientError())
            }
          })
        },
      )
      request.once('error', reject)
      request.end()
    })
  } finally {
    deadline.removeEventListener('abort', cancel)
    resolver.cancel()
  }
}

import { Resolver } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { type TeamGridClient, TeamGridClientError } from '@teamgrid/api-client'

const excluded = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  excluded.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  excluded.addSubnet(address, prefix, 'ipv6')

export function publicTransferAddress(address: string) {
  const family = isIP(address)
  return family === 4
    ? !excluded.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6')
}
function transferError(code = 'file_transfer_failed') {
  return new TeamGridClientError(
    code,
    code === 'file_transfer_too_large'
      ? 'The file exceeds the requested transfer limit. Use the CLI for larger downloads.'
      : 'The private file transfer could not be completed. Request a fresh download; no URL or credential is exposed.',
  )
}

/** This URL comes exclusively from the authenticated API, never from a tool argument. */
export function privateTransferUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw transferError()
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    url.href !== value ||
    value.length > 8192
  )
    throw transferError()
  return url
}

/** Public DNS is checked once and pinned for TLS; redirects and cookies are never followed. */
async function transferBytes(url: URL, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  const abortDns = () => resolver.cancel()
  signal.addEventListener('abort', abortDns, { once: true })
  try {
    signal.throwIfAborted()
    const resolutions = await Promise.allSettled([
      resolver.resolve4(url.hostname),
      resolver.resolve6(url.hostname),
    ])
    signal.throwIfAborted()
    const addresses = resolutions.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 }))
        : [],
    )
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some((item) => !publicTransferAddress(item.address))
    )
      throw transferError()
    const selected = addresses[0]
    if (!selected) throw transferError()
    return await new Promise<Uint8Array>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          servername: url.hostname,
          maxHeaderSize: 16384,
          family: selected.family,
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            done: (...args: unknown[]) => void,
          ) => {
            if (options.all) done(null, [selected])
            else done(null, selected.address, selected.family)
          }) as LookupFunction,
          headers: { 'Accept-Encoding': 'identity' },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          ) {
            response.destroy()
            reject(transferError())
            return
          }
          const declared = Number(response.headers['content-length'])
          if (Number.isFinite(declared) && declared > maximum) {
            response.destroy()
            reject(transferError('file_transfer_too_large'))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > maximum) response.destroy(transferError('file_transfer_too_large'))
            else chunks.push(chunk)
          })
          response.once('error', reject)
          response.once('aborted', () => reject(transferError()))
          response.once('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
        },
      )
      outgoing.once('error', reject)
      outgoing.end()
    })
  } finally {
    signal.removeEventListener('abort', abortDns)
    resolver.cancel()
  }
}

export async function downloadPrivateFile(
  client: TeamGridClient,
  id: string,
  {
    maxBytes = 50 * 1024 * 1024,
    signal: suppliedSignal,
    fetchBytes = transferBytes,
  }: {
    maxBytes?: number
    signal?: AbortSignal
    fetchBytes?: (url: URL, maximum: number, signal: AbortSignal) => Promise<Uint8Array>
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024)
    throw new TeamGridClientError('invalid_arguments', 'Invalid file download limit.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  const signal = suppliedSignal
    ? AbortSignal.any([suppliedSignal, controller.signal])
    : controller.signal
  try {
    const intent = await client.files.createDownloadIntent(id, { signal })
    const { file, transfer } = intent.data.attributes
    const expires = Date.parse(transfer.expiresAt)
    if (
      transfer.method !== 'GET' ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      Object.keys(transfer.headers).length ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw transferError()
    if (file.size > maxBytes) throw transferError('file_transfer_too_large')
    const url = privateTransferUrl(transfer.url)
    const bytes = await fetchBytes(url, maxBytes, signal)
    signal.throwIfAborted()
    if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || bytes.length > maxBytes)
      throw transferError()
    // Re-check current authority after transfer; a grant withdrawn during download must win.
    const current = await client.files.get(id, { signal })
    if (
      !current.data.attributes.downloadAvailable ||
      current.data.attributes.blocked ||
      current.data.attributes.size !== file.size
    )
      throw transferError()
    return { data: bytes, fileName: file.fileName, contentType: file.mimeType }
  } catch (error) {
    if (error instanceof TeamGridClientError && error.code === 'file_transfer_too_large')
      throw error
    throw transferError()
  } finally {
    clearTimeout(timer)
  }
}

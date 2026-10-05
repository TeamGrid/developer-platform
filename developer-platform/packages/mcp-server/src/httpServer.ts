import { createServer, type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

type Handler = { fetch(request: Request): Promise<Response>; close(): Promise<void> }
class BodyLimitError extends Error {}

async function body(request: IncomingMessage, signal: AbortSignal, maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > maxBytes) throw new BodyLimitError()
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** TLS terminates at the regional ingress. It must preserve the canonical Host. */
export function createMcpNodeServer(
  resourceUrl: string,
  handler: Handler,
  options: { ready?(): Promise<boolean>; maxBodyBytes?(pathname: string): number } = {},
) {
  const resource = new URL(resourceUrl)
  const lifetime = new AbortController()
  let active = 0
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 35000, headersTimeout: 10000, keepAliveTimeout: 5000 },
    async (incoming, outgoing) => {
      const reply = (status: number) => {
        outgoing.writeHead(status, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        })
        outgoing.end(JSON.stringify({ status }))
      }
      // Process liveness only; OAuth and functional readiness require the protected smoke test.
      if (incoming.url === '/healthz' && incoming.method === 'GET') {
        reply(200)
        return
      }
      if (incoming.headers.host !== resource.host) {
        reply(421)
        return
      }
      if (incoming.url === '/readyz' && incoming.method === 'GET') {
        try {
          reply((await options.ready?.()) ? 200 : 503)
        } catch {
          reply(503)
        }
        return
      }
      if (Number(incoming.headers['content-length']) > 8 * 1024 * 1024) {
        outgoing.setHeader('Connection', 'close')
        incoming.resume()
        reply(413)
        return
      }
      if (active >= 64 || lifetime.signal.aborted) {
        reply(503)
        return
      }
      active += 1
      const deadline = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, deadline.signal])
      const timer = setTimeout(() => deadline.abort(), 35000)
      timer.unref()
      const disconnect = () => {
        if (!outgoing.writableFinished) deadline.abort()
      }
      const abort = () => {
        incoming.destroy()
        outgoing.destroy()
      }
      outgoing.once('close', disconnect)
      signal.addEventListener('abort', abort, { once: true })
      try {
        // Reject absolute-form and network-path targets; never construct a caller-selected origin.
        if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
          reply(400)
          return
        }
        const url = new URL(incoming.url, resource)
        if (url.origin !== resource.origin) {
          reply(421)
          return
        }
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index]
          const value = incoming.rawHeaders[index + 1]
          if (name === undefined || value === undefined) throw new Error('invalid_headers')
          headers.append(name, value)
        }
        const maxBytes = options.maxBodyBytes?.(url.pathname) ?? 8 * 1024 * 1024
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
          throw new Error('Invalid HTTP body limit.')
        }
        if (Number(incoming.headers['content-length']) > maxBytes) {
          outgoing.setHeader('Connection', 'close')
          incoming.resume()
          reply(413)
          return
        }
        const requestBody =
          incoming.method === 'POST' ? await body(incoming, signal, maxBytes) : undefined
        const result = await handler.fetch(
          new Request(url, {
            method: incoming.method,
            headers,
            signal,
            ...(requestBody ? { body: requestBody } : {}),
          }),
        )
        if (outgoing.destroyed) return
        outgoing.writeHead(result.status, Object.fromEntries(result.headers))
        if (result.body)
          await pipeline(
            Readable.fromWeb(result.body as NodeReadableStream<Uint8Array>),
            outgoing,
            { signal },
          )
        else outgoing.end()
      } catch (error) {
        if (!outgoing.headersSent && !outgoing.destroyed) {
          outgoing.setHeader('Connection', 'close')
          incoming.resume()
          reply(error instanceof BodyLimitError ? 413 : 503)
        } else outgoing.destroy()
      } finally {
        clearTimeout(timer)
        outgoing.removeListener('close', disconnect)
        signal.removeEventListener('abort', abort)
        active -= 1
      }
    },
  )
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  const close = async () => {
    lifetime.abort()
    await Promise.all([
      handler.close(),
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
    ])
  }
  return { server, close }
}

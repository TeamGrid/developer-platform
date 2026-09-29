import { createHmac } from 'node:crypto'
import { McpRateLimitError } from './http.js'

/** Shared regional quotas; bearer values never enter rate-limit storage or logs. */
export function createRegionalMcpAdmission(
  issuer: string,
  serviceSecret: string,
  fetcher: typeof fetch = fetch,
) {
  const endpoint = new URL('/internal/developer/oauth/admission', issuer)
  if (endpoint.protocol !== 'https:' || serviceSecret.length < 32 || serviceSecret.length > 256)
    throw new Error('Invalid MCP admission configuration.')
  return async (request: Request) => {
    const identity = createHmac('sha256', serviceSecret)
      .update(request.headers.get('authorization') ?? 'public-discovery')
      .digest('hex')
    const response = await fetcher(endpoint, {
      method: 'POST',
      signal: request.signal,
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${serviceSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }),
    })
    if (response.status === 429) {
      void response.body?.cancel().catch(() => {})
      throw new McpRateLimitError(response.headers.get('retry-after'))
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error('MCP admission unavailable.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('MCP admission unavailable.')
    const parts: Uint8Array[] = []
    let size = 0
    const abort = () => {
      void reader.cancel().catch(() => {})
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        request.signal.throwIfAborted()
        const chunk = await reader.read()
        request.signal.throwIfAborted()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1024) throw new Error('MCP admission unavailable.')
        parts.push(chunk.value)
      }
      const result: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
      if (
        !result ||
        typeof result !== 'object' ||
        Object.keys(result).length !== 1 ||
        !('admitted' in result) ||
        typeof result.admitted !== 'boolean'
      )
        throw new Error('MCP admission unavailable.')
      return result.admitted
    } finally {
      request.signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
    }
  }
}

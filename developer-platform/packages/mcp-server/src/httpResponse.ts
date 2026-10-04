/**
 * A stateless exchange has one bounded result. Hold it until the handler finishes
 * so a late, trusted API scope refusal can still become an HTTP 403. In particular,
 * the legacy SDK returns its SSE Response before the tool callback has completed.
 */
export async function bufferMcpHttpResponse(response: Response, signal: AbortSignal) {
  if (!response.body) return response
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  // A 1 MiB private binary resource expands to ~1.4 MiB in its JSON/SSE envelope.
  const maxBytes = 2 * 1024 * 1024
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) {
        cancel()
        throw new Error('MCP response exceeds its bounded transport contract.')
      }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

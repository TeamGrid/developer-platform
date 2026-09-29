/** Bounded dependency readiness; process liveness remains available separately. */
export function createMcpReadinessProbe(
  issuer: string,
  enabled: () => boolean,
  fetcher: typeof fetch = fetch,
) {
  const endpoint = new URL('/.well-known/oauth-authorization-server', issuer)
  let pending: Promise<boolean> | undefined
  let cached = { expires: 0, ready: false }
  return async () => {
    if (!enabled()) return false
    if (cached.expires > Date.now()) return cached.ready
    if (pending) return pending
    pending = (async () => {
      const signal = AbortSignal.timeout(3000)
      let ready = false
      try {
        const response = await fetcher(endpoint, { signal, redirect: 'error', credentials: 'omit' })
        const reader = response.body?.getReader()
        if (!response.ok || !reader) {
          await response.body?.cancel()
          return false
        }
        const abort = () => {
          void reader.cancel().catch(() => {})
        }
        signal.addEventListener('abort', abort, { once: true })
        try {
          let text = ''
          let bytes = 0
          const decoder = new TextDecoder('utf-8', { fatal: true })
          while (true) {
            signal.throwIfAborted()
            const value = await reader.read()
            signal.throwIfAborted()
            if (value.done) break
            bytes += value.value.length
            if (bytes > 32768) {
              await reader.cancel()
              return false
            }
            text += decoder.decode(value.value, { stream: true })
          }
          text += decoder.decode()
          const metadata = JSON.parse(text)
          ready =
            metadata.issuer === issuer &&
            metadata.token_endpoint === new URL('/oauth/token', issuer).href &&
            metadata.code_challenge_methods_supported?.includes('S256') === true
        } finally {
          signal.removeEventListener('abort', abort)
          reader.releaseLock()
        }
      } catch {
        ready = false
      } finally {
        cached = { expires: Date.now() + 10000, ready }
      }
      return ready
    })()
    try {
      return await pending
    } finally {
      pending = undefined
    }
  }
}

export async function underSignal(work, signal) {
  signal.throwIfAborted()
  let abort
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new Error('Federated operation interrupted.'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, interrupted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function responseJson(response, signal, maxBytes = 8192) {
  const reader = response.body?.getReader()
  if (
    !response.ok ||
    !reader ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Federated dependency unavailable.')
  }
  const chunks = []
  let bytes = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const value = await underSignal(reader.read(), signal)
      signal.throwIfAborted()
      if (value.done) break
      bytes += value.value.length
      if (bytes > maxBytes) throw new Error('Federated response limit.')
      chunks.push(value.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

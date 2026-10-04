import { describe, expect, it } from 'vitest'
import { bufferMcpHttpResponse } from './httpResponse.js'

describe('bounded stateless HTTP completion', () => {
  it('waits for the legacy SSE callback and preserves its bytes and headers', async () => {
    let complete: (() => void) | undefined
    let callbackFinished = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          complete = () => {
            callbackFinished = true
            controller.enqueue(new TextEncoder().encode('data: {"result":{}}\n\n'))
            controller.close()
          }
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream', 'X-Test': 'preserved' } },
    )
    const buffered = bufferMcpHttpResponse(response, new AbortController().signal)
    complete?.()
    const result = await buffered
    expect(callbackFinished).toBe(true)
    expect(result.headers.get('x-test')).toBe('preserved')
    expect(await result.text()).toBe('data: {"result":{}}\n\n')
  })

  it('allows the largest supported private binary resource envelope', async () => {
    const blob = Buffer.alloc(1024 * 1024).toString('base64')
    const response = Response.json({ contents: [{ uri: 'teamgrid://files/f1', blob }] })
    const result = await bufferMcpHttpResponse(response, new AbortController().signal)
    expect((await result.json()).contents[0].blob).toBe(blob)
  })

  it('cancels an oversized response without returning its payload', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    await expect(bufferMcpHttpResponse(response, new AbortController().signal)).rejects.toThrow(
      'bounded transport',
    )
    expect(cancelled).toBe(true)
  })

  it('cancels a response that never completes when its request is aborted', async () => {
    const controller = new AbortController()
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    )
    const result = bufferMcpHttpResponse(response, controller.signal)
    controller.abort()
    await expect(result).rejects.toThrow()
    expect(cancelled).toBe(true)
  })
})

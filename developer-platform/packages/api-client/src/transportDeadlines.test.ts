import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'

// gitleaks:allow -- synthetic credential; fetch never uses the network.
const token = `tg_sk_v1_us_us-mnz-001_${'a'.repeat(24)}_${'b'.repeat(64)}`
const errorBody = JSON.stringify({ errors: [{ code: 'rate_limited', detail: 'Wait' }] })

afterEach(() => vi.useRealTimers())

describe('request lifetime and rate limits', () => {
  it('keeps the deadline alive after headers and cancels a never-ending body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let signal: AbortSignal | null | undefined
    const fetch = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal
      return new Response(new ReadableStream({ cancel }))
    })
    const client = new TeamGridClient({ fetch, token, timeoutMs: 25 })
    const result = expect(client.tasks.list()).rejects.toMatchObject({ code: 'request_timeout' })
    await vi.advanceTimersByTimeAsync(26)
    await result
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller cancellation after headers even if stream cancellation hangs', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const controller = new AbortController()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })))
    const result = new TeamGridClient({ fetch, token }).tasks.list({ signal: controller.signal })
    const assertion = expect(result).rejects.toMatchObject({ code: 'request_aborted' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not retry or replace an upstream delay exceeding the request budget', async () => {
    const sleep = vi.fn(async () => undefined)
    const fetch = vi.fn(
      async () =>
        new Response(errorBody, {
          status: 429,
          headers: { 'retry-after': '120', 'content-type': 'application/json' },
        }),
    )
    const client = new TeamGridClient({ fetch, sleep, token, timeoutMs: 30_000 })
    await expect(client.tasks.list()).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 })
    expect(sleep).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('honors an HTTP-date Retry-After without clamping', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
    const sleep = vi.fn(async () => undefined)
    const fetch = vi.fn(
      async () =>
        new Response(errorBody, {
          status: 503,
          headers: { 'retry-after': 'Tue, 29 Sep 2026 12:02:00 GMT' },
        }),
    )
    const client = new TeamGridClient({ fetch, sleep, token, retries: 1, timeoutMs: 150_000 })
    await expect(client.tasks.list()).rejects.toMatchObject({ retryAfterMs: 120_000 })
    expect(sleep).toHaveBeenCalledWith(120_000, expect.any(AbortSignal))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans the deadline when an actual streamed body exceeds the bound', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2048))
            },
            cancel,
          }),
        ),
    )
    await expect(
      new TeamGridClient({ fetch, token, maxResponseBytes: 1024 }).tasks.list(),
    ).rejects.toMatchObject({ code: 'response_too_large' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

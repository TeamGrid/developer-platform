import type { ApiErrorDocument } from './types.js'

export class TeamGridApiError extends Error {
  readonly errors: readonly ApiErrorDocument[]
  readonly requestId?: string
  readonly retryAfterMs?: number
  readonly status: number

  constructor({
    errors,
    message,
    requestId,
    retryAfterMs,
    status,
  }: {
    errors?: ApiErrorDocument[]
    message?: string
    requestId?: string
    retryAfterMs?: number
    status: number
  }) {
    const safeErrors = Array.isArray(errors) ? errors.map((error) => ({ ...error })) : []
    super(message || safeErrors[0]?.detail || `TeamGrid API request failed with status ${status}.`)
    this.name = 'TeamGridApiError'
    this.errors = Object.freeze(safeErrors)
    this.requestId = requestId
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

export class TeamGridClientError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TeamGridClientError'
    this.code = code
  }
}

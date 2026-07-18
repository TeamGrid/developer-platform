import { TeamGridApiError, TeamGridClientError } from './errors.js'
import { buildRegionalApiBaseUrl, normalizeApiBaseUrl, parseCredentialLocation } from './routing.js'
import type {
  AuditEvent,
  AuditEventListOptions,
  Contact,
  ContactListOptions,
  ListEnvelope,
  ListLookupListOptions,
  ListOptions,
  Lookup,
  LookupListOptions,
  MutationOptions,
  PaginationOptions,
  Project,
  ProjectListOptions,
  RequestOptions,
  ResourceEnvelope,
  Task,
  TaskCreate,
  TaskListOptions,
  TaskUpdate,
  TimeEntry,
  TimeEntryCreate,
  TimeEntryListOptions,
  TimeEntryUpdate,
  User,
  Webhook,
  WebhookCreate,
  WebhookListOptions,
  Workspace,
} from './types.js'

type Fetch = typeof globalThis.fetch
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>
type QueryValue = boolean | number | string | Date | null | undefined
type Query = Record<string, QueryValue | QueryValue[]>

type InternalRequestOptions = RequestOptions & {
  body?: unknown
  idempotencyKey?: string
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST'
  query?: Query
}

export type TeamGridClientOptions = {
  apiRootDomain?: string
  baseUrl?: string
  fetch?: Fetch
  maxResponseBytes?: number
  random?: () => number
  retries?: number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  timeoutMs?: number
  token: string
}

const retryStatuses = new Set([429, 502, 503, 504])
const maxRetryDelayMs = 30_000
const defaultMaxResponseBytes = 8 * 1024 * 1024

function isoQueryValue(value: QueryValue) {
  return value instanceof Date ? value.toISOString() : String(value)
}

function addQuery(url: URL, query?: Query) {
  if (!query) return
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) {
      if (value === undefined || value === null) continue
      url.searchParams.append(key, isoQueryValue(value))
    }
  }
}

function parseRetryAfter(value: string | null, now = Date.now()) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxRetryDelayMs)
  }
  const date = new Date(value).getTime()
  if (!Number.isFinite(date)) return undefined
  return Math.min(Math.max(date - now, 0), maxRetryDelayMs)
}

function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const complete = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(complete, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function newRequestId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new TeamGridClientError(
      'secure_random_unavailable',
      'A Web Crypto randomUUID implementation is required.',
    )
  }
  return globalThis.crypto.randomUUID()
}

function buildCombinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  if (timeoutMs > 0) {
    timeout = setTimeout(
      () =>
        controller.abort(
          new TeamGridClientError(
            'request_timeout',
            `The TeamGrid API request exceeded ${timeoutMs} ms.`,
          ),
        ),
      timeoutMs,
    )
  }
  return {
    cleanup() {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    },
    signal: controller.signal,
  }
}

async function readBoundedResponseText(response: Response, maxResponseBytes: number) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await response.body?.cancel()
    throw new TeamGridClientError(
      'response_too_large',
      `The TeamGrid API response exceeded ${maxResponseBytes} bytes.`,
    )
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxResponseBytes) {
      throw new TeamGridClientError(
        'response_too_large',
        `The TeamGrid API response exceeded ${maxResponseBytes} bytes.`,
      )
    }
    return new TextDecoder().decode(bytes)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxResponseBytes) {
      await reader.cancel()
      throw new TeamGridClientError(
        'response_too_large',
        `The TeamGrid API response exceeded ${maxResponseBytes} bytes.`,
      )
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function parseJsonResponse(response: Response, maxResponseBytes: number) {
  const text = await readBoundedResponseText(response, maxResponseBytes)
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'The TeamGrid API returned malformed JSON.',
      { cause: error },
    )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRetryableMethod(method: string, idempotencyKey?: string) {
  return method === 'GET' || (method === 'POST' && Boolean(idempotencyKey))
}

function expectedResourceTypes(path: string) {
  const root = path.split('/').filter(Boolean)[0]
  const mapping: Record<string, string[]> = {
    'audit-events': ['auditEvent'],
    contacts: ['contact'],
    lists: ['list'],
    projects: ['project'],
    services: ['service'],
    tags: ['tag'],
    tasks: ['task'],
    'time-entries': ['timeEntry'],
    users: ['user'],
    webhooks: ['webhook'],
    workspace: ['workspace'],
  }
  return mapping[root || ''] || []
}

function assertResourceValue(value: unknown, expectedTypes: string[]) {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.type !== 'string' ||
    !expectedTypes.includes(value.type) ||
    !isObject(value.attributes)
  ) {
    throw new TeamGridClientError(
      'invalid_api_response',
      `Expected a TeamGrid ${expectedTypes.join(' or ')} resource.`,
    )
  }
}

function assertPage<T>(value: unknown, expectedTypes: string[]): ListEnvelope<T> {
  if (
    !isObject(value) ||
    !Array.isArray(value.data) ||
    !isObject(value.meta) ||
    typeof value.meta.requestId !== 'string' ||
    !isObject(value.meta.page) ||
    typeof value.meta.page.limit !== 'number' ||
    !(value.meta.page.nextCursor === null || typeof value.meta.page.nextCursor === 'string')
  ) {
    throw new TeamGridClientError('invalid_api_response', 'Expected a TeamGrid list envelope.')
  }
  value.data.forEach((resource) => {
    assertResourceValue(resource, expectedTypes)
  })
  return value as ListEnvelope<T>
}

function assertResource<T>(value: unknown, expectedTypes: string[]): ResourceEnvelope<T> {
  if (
    !isObject(value) ||
    !isObject(value.data) ||
    !isObject(value.meta) ||
    typeof value.meta.requestId !== 'string'
  ) {
    throw new TeamGridClientError('invalid_api_response', 'Expected a TeamGrid resource envelope.')
  }
  assertResourceValue(value.data, expectedTypes)
  return value as ResourceEnvelope<T>
}

export class TeamGridClient {
  readonly auditEvents
  readonly contacts
  readonly lists
  readonly location
  readonly projects
  readonly services
  readonly tags
  readonly tasks
  readonly timeEntries
  readonly users
  readonly webhooks
  readonly workspace

  readonly #baseUrl: string
  readonly #fetch: Fetch
  readonly #maxResponseBytes: number
  readonly #random: () => number
  readonly #retries: number
  readonly #sleep: Sleep
  readonly #timeoutMs: number
  readonly #token: string

  constructor(options: TeamGridClientOptions) {
    this.#token = String(options.token || '').trim()
    this.location = parseCredentialLocation(this.#token)
    this.#baseUrl = normalizeApiBaseUrl(
      options.baseUrl || buildRegionalApiBaseUrl(this.location.region, options.apiRootDomain),
    )
    this.#fetch = options.fetch || globalThis.fetch
    if (typeof this.#fetch !== 'function') {
      throw new TeamGridClientError('fetch_unavailable', 'A Fetch API implementation is required.')
    }
    this.#maxResponseBytes = Math.max(
      1024,
      Math.min(Math.trunc(options.maxResponseBytes ?? defaultMaxResponseBytes), 64 * 1024 * 1024),
    )
    this.#random = options.random || Math.random
    this.#retries = Math.max(0, Math.min(Math.trunc(options.retries ?? 2), 5))
    this.#sleep = options.sleep || defaultSleep
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000))

    this.workspace = {
      get: (options?: RequestOptions) => this.#resource<Workspace>('/workspace', options),
    }
    this.projects = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Project>(`/projects/${encodeURIComponent(id)}`, options),
      list: (options?: ProjectListOptions) => this.#page<Project>('/projects', options),
      pages: (options?: ProjectListOptions, pagination?: PaginationOptions) =>
        this.#pages<Project>('/projects', options, pagination),
    }
    this.tasks = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/tasks/${encodeURIComponent(id)}`, options),
      create: (data: TaskCreate, options?: MutationOptions) =>
        this.#create<Task>('/tasks', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Task>(`/tasks/${encodeURIComponent(id)}`, options),
      list: (options?: TaskListOptions) => this.#page<Task>('/tasks', options),
      pages: (options?: TaskListOptions, pagination?: PaginationOptions) =>
        this.#pages<Task>('/tasks', options, pagination),
      update: (id: string, data: TaskUpdate, options?: RequestOptions) =>
        this.#update<Task>(`/tasks/${encodeURIComponent(id)}`, data, options),
    }
    this.timeEntries = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/time-entries/${encodeURIComponent(id)}`, options),
      create: (data: TimeEntryCreate, options?: MutationOptions) =>
        this.#create<TimeEntry>('/time-entries', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<TimeEntry>(`/time-entries/${encodeURIComponent(id)}`, options),
      list: (options?: TimeEntryListOptions) => this.#page<TimeEntry>('/time-entries', options),
      pages: (options?: TimeEntryListOptions, pagination?: PaginationOptions) =>
        this.#pages<TimeEntry>('/time-entries', options, pagination),
      update: (id: string, data: TimeEntryUpdate, options?: RequestOptions) =>
        this.#update<TimeEntry>(`/time-entries/${encodeURIComponent(id)}`, data, options),
    }
    this.contacts = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Contact>(`/contacts/${encodeURIComponent(id)}`, options),
      list: (options?: ContactListOptions) => this.#page<Contact>('/contacts', options),
      pages: (options?: ContactListOptions, pagination?: PaginationOptions) =>
        this.#pages<Contact>('/contacts', options, pagination),
    }
    this.users = {
      list: (options?: ListOptions) => this.#page<User>('/users', options),
      pages: (options?: ListOptions, pagination?: PaginationOptions) =>
        this.#pages<User>('/users', options, pagination),
    }
    this.lists = {
      list: (options?: ListLookupListOptions) => this.#page<Lookup>('/lists', options),
      pages: (options?: ListLookupListOptions, pagination?: PaginationOptions) =>
        this.#pages<Lookup>('/lists', options, pagination),
    }
    this.services = this.#lookupClient('/services')
    this.tags = this.#lookupClient('/tags')
    this.auditEvents = {
      list: (options?: AuditEventListOptions) => this.#page<AuditEvent>('/audit-events', options),
      pages: (options?: AuditEventListOptions, pagination?: PaginationOptions) =>
        this.#pages<AuditEvent>('/audit-events', options, pagination),
    }
    this.webhooks = {
      create: (data: WebhookCreate, options?: MutationOptions) =>
        this.#create<Webhook>('/webhooks', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Webhook>(`/webhooks/${encodeURIComponent(id)}`, options),
      list: (options?: WebhookListOptions) => this.#page<Webhook>('/webhooks', options),
      pages: (options?: WebhookListOptions, pagination?: PaginationOptions) =>
        this.#pages<Webhook>('/webhooks', options, pagination),
      remove: (id: string, options?: RequestOptions) =>
        this.#archive(`/webhooks/${encodeURIComponent(id)}`, options),
    }
  }

  #lookupClient(path: string) {
    return {
      list: (options?: LookupListOptions) => this.#page<Lookup>(path, options),
      pages: (options?: LookupListOptions, pagination?: PaginationOptions) =>
        this.#pages<Lookup>(path, options, pagination),
    }
  }

  async #request(path: string, options: InternalRequestOptions = {}) {
    const method = options.method || 'GET'
    const url = new URL(`${this.#baseUrl}${path}`)
    addQuery(url, options.query)
    const requestId = options.requestId || newRequestId()
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
      'x-request-id': requestId,
    })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const combined = buildCombinedSignal(options.signal, this.#timeoutMs)
      let response: Response
      try {
        response = await this.#fetch(url, {
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          headers,
          method,
          redirect: 'manual',
          signal: combined.signal,
        })
      } catch (error) {
        combined.cleanup()
        if (
          attempt < this.#retries &&
          isRetryableMethod(method, options.idempotencyKey) &&
          !options.signal?.aborted
        ) {
          await this.#sleep(this.#retryDelay(attempt), options.signal)
          continue
        }
        if (error instanceof TeamGridClientError) throw error
        throw new TeamGridClientError(
          combined.signal.aborted ? 'request_aborted' : 'network_error',
          combined.signal.aborted
            ? 'The TeamGrid API request was aborted.'
            : 'The TeamGrid API request could not reach the service.',
          { cause: error },
        )
      } finally {
        combined.cleanup()
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      if (
        retryStatuses.has(response.status) &&
        attempt < this.#retries &&
        isRetryableMethod(method, options.idempotencyKey)
      ) {
        await response.body?.cancel()
        await this.#sleep(retryAfterMs ?? this.#retryDelay(attempt), options.signal)
        continue
      }
      const payload = await parseJsonResponse(response, this.#maxResponseBytes)
      if (!response.ok) {
        const envelope = isObject(payload) ? payload : {}
        throw new TeamGridApiError({
          errors: Array.isArray(envelope.errors) ? envelope.errors : undefined,
          requestId:
            isObject(envelope.meta) && typeof envelope.meta.requestId === 'string'
              ? envelope.meta.requestId
              : response.headers.get('x-request-id') || requestId,
          retryAfterMs,
          status: response.status,
        })
      }
      return payload
    }
    throw new TeamGridClientError('retry_exhausted', 'The TeamGrid API retry budget was exhausted.')
  }

  #retryDelay(attempt: number) {
    return Math.min(250 * 2 ** attempt + Math.floor(this.#random() * 100), maxRetryDelayMs)
  }

  async #resource<T>(path: string, options?: RequestOptions) {
    return assertResource<T>(await this.#request(path, options), expectedResourceTypes(path))
  }

  async #page<T>(path: string, options: ListOptions & Record<string, unknown> = {}) {
    const { requestId, signal, ...query } = options
    return assertPage<T>(
      await this.#request(path, {
        query: query as Query,
        requestId,
        signal,
      }),
      expectedResourceTypes(path),
    )
  }

  async *#pages<T>(
    path: string,
    options: ListOptions & Record<string, unknown> = {},
    pagination: PaginationOptions = {},
  ) {
    let cursor = options.cursor
    const seen = new Set<string>()
    const maxPages = Math.max(1, Math.min(Math.trunc(pagination.maxPages ?? 10_000), 10_000))
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.#page<T>(path, {
        ...options,
        cursor,
        signal: pagination.signal || options.signal,
      })
      yield page
      const nextCursor = page.meta.page.nextCursor
      if (!nextCursor) return
      if (seen.has(nextCursor)) {
        throw new TeamGridClientError(
          'pagination_cycle',
          'The TeamGrid API returned a repeated pagination cursor.',
        )
      }
      seen.add(nextCursor)
      cursor = nextCursor
    }
    throw new TeamGridClientError(
      'pagination_limit',
      `Pagination exceeded the configured ${maxPages}-page safety limit.`,
    )
  }

  async #create<T>(path: string, data: unknown, options: MutationOptions = {}) {
    return assertResource<T>(
      await this.#request(path, {
        ...options,
        body: data,
        idempotencyKey: options.idempotencyKey || newRequestId(),
        method: 'POST',
      }),
      expectedResourceTypes(path),
    )
  }

  async #update<T>(path: string, data: unknown, options: RequestOptions = {}) {
    return assertResource<T>(
      await this.#request(path, {
        ...options,
        body: data,
        method: 'PATCH',
      }),
      expectedResourceTypes(path),
    )
  }

  async #archive(path: string, options: RequestOptions = {}) {
    await this.#request(path, { ...options, method: 'DELETE' })
  }
}

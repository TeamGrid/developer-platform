import { TeamGridApiError, TeamGridClientError } from './errors.js'
import { buildRegionalApiBaseUrl, normalizeApiBaseUrl, parseCredentialLocation } from './routing.js'
import type {
  ApiVersionEnvelope,
  AuditEvent,
  AuditEventListOptions,
  CallNote,
  CallNoteCreate,
  CallNoteListOptions,
  ChangeCatchUpOptions,
  ChangeCheckpoint,
  ChangeFeedBootstrap,
  ChangeFilterOptions,
  ChangeListOptions,
  ChangePageEnvelope,
  Contact,
  ContactCreate,
  ContactGroup,
  ContactGroupCreate,
  ContactGroupListOptions,
  ContactGroupUpdate,
  ContactListOptions,
  ContactUpdate,
  CustomFieldDefinition,
  CustomFieldDefinitionCreate,
  CustomFieldDefinitionListOptions,
  CustomFieldDefinitionUpdate,
  CustomFieldValue,
  CustomFieldValueMutation,
  CustomFieldValueMutationOptions,
  CustomFieldValueSet,
  CustomFieldValueTargetType,
  List,
  ListCreate,
  ListEnvelope,
  ListLookupListOptions,
  ListOptions,
  ListUpdate,
  LookupListOptions,
  MutationOptions,
  PaginationOptions,
  PlannedWork,
  PlannedWorkListOptions,
  PlannedWorkOperation,
  PlannedWorkOperationWaitOptions,
  PlannedWorkReplacement,
  PlannedWorkReplaceOptions,
  Product,
  ProductCreate,
  ProductGroup,
  ProductGroupCreate,
  ProductGroupListOptions,
  ProductGroupUpdate,
  ProductListOptions,
  ProductUpdate,
  Project,
  ProjectCreate,
  ProjectLifecycleOperation,
  ProjectLifecycleWaitOptions,
  ProjectListOptions,
  ProjectStatement,
  ProjectStatementCreate,
  ProjectStatementListOptions,
  ProjectStatementUpdate,
  ProjectTemplate,
  ProjectTemplateCreate,
  ProjectTemplateInstantiate,
  ProjectTemplateInstantiation,
  ProjectTemplateInstantiationWaitOptions,
  ProjectTemplateListOptions,
  ProjectTemplateUpdate,
  ProjectUpdate,
  RequestOptions,
  ResourceEnvelope,
  Service,
  ServiceCreate,
  ServiceUpdate,
  Tag,
  TagCreate,
  TagUpdate,
  Task,
  TaskCreate,
  TaskListOptions,
  TaskPlannedWork,
  TaskUpdate,
  TimeEntry,
  TimeEntryCreate,
  TimeEntryListOptions,
  TimeEntryUpdate,
  TimerAction,
  TransportMetadata,
  User,
  Webhook,
  WebhookCreate,
  WebhookDelivery,
  WebhookDeliveryListOptions,
  WebhookListOptions,
  Workspace,
} from './types.js'
import { apiClientVersion } from './version.js'

type Fetch = typeof globalThis.fetch
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>
type QueryValue = boolean | number | string | Date | null | undefined
type Query = Record<string, QueryValue | QueryValue[]>

type InternalRequestOptions = RequestOptions & {
  body?: unknown
  idempotencyKey?: string
  ifMatch?: string
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  query?: Query
}

type InternalResponse = {
  payload: unknown
  transport: Readonly<TransportMetadata>
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
  return method === 'GET' || ((method === 'POST' || method === 'PUT') && Boolean(idempotencyKey))
}

function strongCustomFieldValueEtag(value: string) {
  const revision = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  if (!/^cfv1-[a-f0-9]{64}$/.test(revision)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Custom-field-value ifMatch must be a canonical revision or one strong ETag.',
    )
  }
  return `"${revision}"`
}

function strongPlannedWorkEtag(value: string) {
  const revision = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  if (!/^pw1-[a-f0-9]{64}$/.test(revision)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Planned-work ifMatch must be a canonical revision or one strong ETag.',
    )
  }
  return `"${revision}"`
}

function customFieldValuePath(
  targetType: CustomFieldValueTargetType,
  resourceId: string,
  fieldId: string,
) {
  return [
    '/custom-field-values',
    encodeURIComponent(targetType),
    encodeURIComponent(resourceId),
    encodeURIComponent(fieldId),
  ].join('/')
}

function expectedResourceTypes(path: string) {
  if (/^\/tasks\/[^/]+\/timer\/(?:start|stop)$/.test(path)) return ['timeEntry']
  if (/^\/tasks\/[^/]+\/planned-work$/.test(path)) return ['taskPlannedWork']
  if (/^\/project-templates\/[^/]+\/instantiate$/.test(path)) {
    return ['projectTemplateInstantiation']
  }
  if (/^\/projects\/[^/]+\/(?:complete|reopen|archive|restore)$/.test(path)) {
    return ['projectLifecycleOperation']
  }
  const root = path.split('/').filter(Boolean)[0]
  const mapping: Record<string, string[]> = {
    'audit-events': ['auditEvent'],
    'call-notes': ['callNote'],
    changes: ['changeEvent'],
    contacts: ['contact'],
    'contact-groups': ['contactGroup'],
    'custom-field-definitions': ['customFieldDefinition'],
    'custom-field-values': ['customFieldValue'],
    lists: ['list'],
    'product-groups': ['productGroup'],
    products: ['product'],
    'planned-work': ['plannedWork'],
    'planned-work-operations': ['plannedWorkOperation'],
    projects: ['project'],
    'project-lifecycle-operations': ['projectLifecycleOperation'],
    'project-statements': ['projectStatement'],
    'project-template-instantiations': ['projectTemplateInstantiation'],
    'project-templates': ['projectTemplate'],
    services: ['service'],
    tags: ['tag'],
    tasks: ['task'],
    'time-entries': ['timeEntry'],
    users: ['user'],
    'webhook-deliveries': ['webhookDelivery'],
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

function assertChangePage(value: unknown): ChangePageEnvelope {
  const page = assertPage(value, ['changeEvent'])
  if (
    typeof page.meta.page.nextCursor !== 'string' ||
    !page.meta.page.nextCursor ||
    typeof (page.meta.page as unknown as { caughtUp?: unknown }).caughtUp !== 'boolean' ||
    !Number.isInteger(page.meta.page.limit) ||
    page.meta.page.limit < 1 ||
    page.meta.page.limit > 200 ||
    page.data.length > page.meta.page.limit ||
    (!(page.meta.page as unknown as { caughtUp: boolean }).caughtUp &&
      page.data.length !== page.meta.page.limit)
  ) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'Expected a TeamGrid change-feed checkpoint.',
    )
  }
  return page as ChangePageEnvelope
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

function assertApiVersion(value: unknown): ApiVersionEnvelope {
  if (
    !isObject(value) ||
    !isObject(value.data) ||
    value.data.version !== '1' ||
    typeof value.data.documentation !== 'string' ||
    !isObject(value.meta) ||
    typeof value.meta.requestId !== 'string'
  ) {
    throw new TeamGridClientError('invalid_api_response', 'Expected TeamGrid API discovery data.')
  }
  return value as ApiVersionEnvelope
}

function numericHeader(headers: Headers, name: string) {
  const value = headers.get(name)
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function transportMetadata({
  attempts,
  fallbackRequestId,
  response,
  retryAfterMs,
}: {
  attempts: number
  fallbackRequestId: string
  response: Response
  retryAfterMs?: number
}): Readonly<TransportMetadata> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const replayed = response.headers.get('idempotency-replayed')
  return Object.freeze({
    attempts,
    headers: Object.freeze(headers),
    ...(replayed === null ? {} : { idempotencyReplayed: replayed === 'true' }),
    rateLimit: Object.freeze({
      limit: numericHeader(response.headers, 'x-ratelimit-limit'),
      remaining: numericHeader(response.headers, 'x-ratelimit-remaining'),
      reset: numericHeader(response.headers, 'x-ratelimit-reset'),
    }),
    requestId: response.headers.get('x-request-id') || fallbackRequestId,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    status: response.status,
  })
}

function attachTransport<T extends object>(value: T, transport: Readonly<TransportMetadata>) {
  Object.defineProperty(value, 'transport', {
    configurable: false,
    enumerable: false,
    value: transport,
    writable: false,
  })
  return value as T & { readonly transport: Readonly<TransportMetadata> }
}

export class TeamGridClient {
  readonly auditEvents
  readonly callNotes
  readonly changes
  readonly contacts
  readonly contactGroups
  readonly customFieldDefinitions
  readonly customFieldValues
  readonly lists
  readonly location
  readonly plannedWork
  readonly plannedWorkOperations
  readonly productGroups
  readonly products
  readonly projects
  readonly projectLifecycleOperations
  readonly projectStatements
  readonly projectTemplateInstantiations
  readonly projectTemplates
  readonly services
  readonly system
  readonly tags
  readonly tasks
  readonly timeEntries
  readonly users
  readonly webhookDeliveries
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
    this.system = {
      getApiVersion: async (options?: RequestOptions) => {
        const response = await this.#request('/', options)
        return attachTransport(assertApiVersion(response.payload), response.transport)
      },
    }
    this.changes = {
      checkpoint: (options?: ChangeFilterOptions) =>
        this.#changePage({ ...options, startAtLatest: true }),
      list: (options?: ChangeListOptions) => this.#changePage(options),
      pages: (options?: ChangeCatchUpOptions, pagination?: PaginationOptions) =>
        this.#changePages(options, pagination),
      snapshotThenCatchUp: <T>(
        snapshot: (checkpoint: ChangeCheckpoint) => Promise<T>,
        options?: ChangeFilterOptions,
        pagination?: PaginationOptions,
      ) => this.#snapshotThenCatchUp(snapshot, options, pagination),
    }
    this.plannedWork = {
      getForTask: (id: string, options?: RequestOptions) =>
        this.#resource<TaskPlannedWork>(`/tasks/${encodeURIComponent(id)}/planned-work`, options),
      list: (options: PlannedWorkListOptions) => this.#page<PlannedWork>('/planned-work', options),
      pages: (options: PlannedWorkListOptions, pagination?: PaginationOptions) =>
        this.#pages<PlannedWork>('/planned-work', options, pagination),
      replaceForTask: (
        id: string,
        data: PlannedWorkReplacement,
        options: PlannedWorkReplaceOptions,
      ) => this.#replaceTaskPlannedWork(id, data, options),
    }
    this.plannedWorkOperations = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<PlannedWorkOperation>(
          `/planned-work-operations/${encodeURIComponent(id)}`,
          options,
        ),
      wait: (id: string, options?: PlannedWorkOperationWaitOptions) =>
        this.#waitForPlannedWorkOperation(id, options),
    }
    this.projects = {
      archive: (id: string, options?: MutationOptions) =>
        this.#create<ProjectLifecycleOperation>(
          `/projects/${encodeURIComponent(id)}/archive`,
          undefined,
          options,
        ),
      complete: (id: string, options?: MutationOptions) =>
        this.#create<ProjectLifecycleOperation>(
          `/projects/${encodeURIComponent(id)}/complete`,
          undefined,
          options,
        ),
      create: (data: ProjectCreate, options?: MutationOptions) =>
        this.#create<Project>('/projects', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Project>(`/projects/${encodeURIComponent(id)}`, options),
      list: (options?: ProjectListOptions) => this.#page<Project>('/projects', options),
      pages: (options?: ProjectListOptions, pagination?: PaginationOptions) =>
        this.#pages<Project>('/projects', options, pagination),
      reopen: (id: string, options?: MutationOptions) =>
        this.#create<ProjectLifecycleOperation>(
          `/projects/${encodeURIComponent(id)}/reopen`,
          undefined,
          options,
        ),
      restore: (id: string, options?: MutationOptions) =>
        this.#create<ProjectLifecycleOperation>(
          `/projects/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: ProjectUpdate, options?: RequestOptions) =>
        this.#update<Project>(`/projects/${encodeURIComponent(id)}`, data, options),
    }
    this.projectLifecycleOperations = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ProjectLifecycleOperation>(
          `/project-lifecycle-operations/${encodeURIComponent(id)}`,
          options,
        ),
      wait: (id: string, options?: ProjectLifecycleWaitOptions) =>
        this.#waitForProjectLifecycleOperation(id, options),
    }
    this.products = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/products/${encodeURIComponent(id)}`, options),
      create: (data: ProductCreate, options?: MutationOptions) =>
        this.#create<Product>('/products', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Product>(`/products/${encodeURIComponent(id)}`, options),
      list: (options?: ProductListOptions) => this.#page<Product>('/products', options),
      pages: (options?: ProductListOptions, pagination?: PaginationOptions) =>
        this.#pages<Product>('/products', options, pagination),
      update: (id: string, data: ProductUpdate, options?: RequestOptions) =>
        this.#update<Product>(`/products/${encodeURIComponent(id)}`, data, options),
    }
    this.productGroups = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/product-groups/${encodeURIComponent(id)}`, options),
      create: (data: ProductGroupCreate, options?: MutationOptions) =>
        this.#create<ProductGroup>('/product-groups', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ProductGroup>(`/product-groups/${encodeURIComponent(id)}`, options),
      list: (options?: ProductGroupListOptions) =>
        this.#page<ProductGroup>('/product-groups', options),
      pages: (options?: ProductGroupListOptions, pagination?: PaginationOptions) =>
        this.#pages<ProductGroup>('/product-groups', options, pagination),
      update: (id: string, data: ProductGroupUpdate, options?: RequestOptions) =>
        this.#update<ProductGroup>(`/product-groups/${encodeURIComponent(id)}`, data, options),
    }
    this.projectStatements = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/project-statements/${encodeURIComponent(id)}`, options),
      create: (data: ProjectStatementCreate, options?: MutationOptions) =>
        this.#create<ProjectStatement>('/project-statements', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ProjectStatement>(`/project-statements/${encodeURIComponent(id)}`, options),
      list: (options?: ProjectStatementListOptions) =>
        this.#page<ProjectStatement>('/project-statements', options),
      pages: (options?: ProjectStatementListOptions, pagination?: PaginationOptions) =>
        this.#pages<ProjectStatement>('/project-statements', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<ProjectStatement>(
          `/project-statements/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: ProjectStatementUpdate, options?: RequestOptions) =>
        this.#update<ProjectStatement>(
          `/project-statements/${encodeURIComponent(id)}`,
          data,
          options,
        ),
    }
    this.tasks = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/tasks/${encodeURIComponent(id)}`, options),
      complete: (id: string, options?: RequestOptions) =>
        this.#action<Task>(`/tasks/${encodeURIComponent(id)}/complete`, undefined, options),
      create: (data: TaskCreate, options?: MutationOptions) =>
        this.#create<Task>('/tasks', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Task>(`/tasks/${encodeURIComponent(id)}`, options),
      list: (options?: TaskListOptions) => this.#page<Task>('/tasks', options),
      pages: (options?: TaskListOptions, pagination?: PaginationOptions) =>
        this.#pages<Task>('/tasks', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<Task>(`/tasks/${encodeURIComponent(id)}/restore`, undefined, options),
      reopen: (id: string, options?: RequestOptions) =>
        this.#action<Task>(`/tasks/${encodeURIComponent(id)}/reopen`, undefined, options),
      startTimer: (id: string, data: TimerAction, options?: RequestOptions) =>
        this.#action<TimeEntry>(`/tasks/${encodeURIComponent(id)}/timer/start`, data, options),
      stopTimer: (id: string, data: TimerAction, options?: RequestOptions) =>
        this.#action<TimeEntry>(`/tasks/${encodeURIComponent(id)}/timer/stop`, data, options),
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
      restore: (id: string, options?: RequestOptions) =>
        this.#action<TimeEntry>(
          `/time-entries/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: TimeEntryUpdate, options?: RequestOptions) =>
        this.#update<TimeEntry>(`/time-entries/${encodeURIComponent(id)}`, data, options),
    }
    this.callNotes = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/call-notes/${encodeURIComponent(id)}`, options),
      create: (data: CallNoteCreate, options?: MutationOptions) =>
        this.#create<CallNote>('/call-notes', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<CallNote>(`/call-notes/${encodeURIComponent(id)}`, options),
      list: (options?: CallNoteListOptions) => this.#page<CallNote>('/call-notes', options),
      pages: (options?: CallNoteListOptions, pagination?: PaginationOptions) =>
        this.#pages<CallNote>('/call-notes', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<CallNote>(`/call-notes/${encodeURIComponent(id)}/restore`, undefined, options),
    }
    this.contacts = {
      create: (data: ContactCreate, options?: MutationOptions) =>
        this.#create<Contact>('/contacts', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Contact>(`/contacts/${encodeURIComponent(id)}`, options),
      list: (options?: ContactListOptions) => this.#page<Contact>('/contacts', options),
      pages: (options?: ContactListOptions, pagination?: PaginationOptions) =>
        this.#pages<Contact>('/contacts', options, pagination),
      update: (id: string, data: ContactUpdate, options?: RequestOptions) =>
        this.#update<Contact>(`/contacts/${encodeURIComponent(id)}`, data, options),
    }
    this.contactGroups = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/contact-groups/${encodeURIComponent(id)}`, options),
      create: (data: ContactGroupCreate, options?: MutationOptions) =>
        this.#create<ContactGroup>('/contact-groups', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ContactGroup>(`/contact-groups/${encodeURIComponent(id)}`, options),
      list: (options?: ContactGroupListOptions) =>
        this.#page<ContactGroup>('/contact-groups', options),
      pages: (options?: ContactGroupListOptions, pagination?: PaginationOptions) =>
        this.#pages<ContactGroup>('/contact-groups', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<ContactGroup>(
          `/contact-groups/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: ContactGroupUpdate, options?: RequestOptions) =>
        this.#update<ContactGroup>(`/contact-groups/${encodeURIComponent(id)}`, data, options),
    }
    this.customFieldDefinitions = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/custom-field-definitions/${encodeURIComponent(id)}`, options),
      create: (data: CustomFieldDefinitionCreate, options?: MutationOptions) =>
        this.#create<CustomFieldDefinition>('/custom-field-definitions', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<CustomFieldDefinition>(
          `/custom-field-definitions/${encodeURIComponent(id)}`,
          options,
        ),
      list: (options?: CustomFieldDefinitionListOptions) =>
        this.#page<CustomFieldDefinition>('/custom-field-definitions', options),
      pages: (options?: CustomFieldDefinitionListOptions, pagination?: PaginationOptions) =>
        this.#pages<CustomFieldDefinition>('/custom-field-definitions', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<CustomFieldDefinition>(
          `/custom-field-definitions/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: CustomFieldDefinitionUpdate, options?: RequestOptions) =>
        this.#update<CustomFieldDefinition>(
          `/custom-field-definitions/${encodeURIComponent(id)}`,
          data,
          options,
        ),
    }
    this.customFieldValues = {
      clear: (
        targetType: CustomFieldValueTargetType,
        resourceId: string,
        fieldId: string,
        options: CustomFieldValueMutationOptions,
      ) =>
        this.#customFieldValueMutation(
          customFieldValuePath(targetType, resourceId, fieldId),
          'DELETE',
          undefined,
          options,
        ),
      get: (
        targetType: CustomFieldValueTargetType,
        resourceId: string,
        fieldId: string,
        options?: RequestOptions,
      ) =>
        this.#resource<CustomFieldValue>(
          customFieldValuePath(targetType, resourceId, fieldId),
          options,
        ),
      set: (
        targetType: CustomFieldValueTargetType,
        resourceId: string,
        fieldId: string,
        data: CustomFieldValueSet,
        options: CustomFieldValueMutationOptions,
      ) =>
        this.#customFieldValueMutation(
          customFieldValuePath(targetType, resourceId, fieldId),
          'PUT',
          data,
          options,
        ),
    }
    this.projectTemplates = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/project-templates/${encodeURIComponent(id)}`, options),
      create: (data: ProjectTemplateCreate, options?: MutationOptions) =>
        this.#create<ProjectTemplate>('/project-templates', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ProjectTemplate>(`/project-templates/${encodeURIComponent(id)}`, options),
      instantiate: (id: string, data: ProjectTemplateInstantiate, options?: MutationOptions) =>
        this.#create<ProjectTemplateInstantiation>(
          `/project-templates/${encodeURIComponent(id)}/instantiate`,
          data,
          options,
        ),
      list: (options?: ProjectTemplateListOptions) =>
        this.#page<ProjectTemplate>('/project-templates', options),
      pages: (options?: ProjectTemplateListOptions, pagination?: PaginationOptions) =>
        this.#pages<ProjectTemplate>('/project-templates', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<ProjectTemplate>(
          `/project-templates/${encodeURIComponent(id)}/restore`,
          undefined,
          options,
        ),
      update: (id: string, data: ProjectTemplateUpdate, options?: RequestOptions) =>
        this.#update<ProjectTemplate>(
          `/project-templates/${encodeURIComponent(id)}`,
          data,
          options,
        ),
    }
    this.projectTemplateInstantiations = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<ProjectTemplateInstantiation>(
          `/project-template-instantiations/${encodeURIComponent(id)}`,
          options,
        ),
      wait: (id: string, options?: ProjectTemplateInstantiationWaitOptions) =>
        this.#waitForProjectTemplateInstantiation(id, options),
    }
    this.users = {
      list: (options?: ListOptions) => this.#page<User>('/users', options),
      pages: (options?: ListOptions, pagination?: PaginationOptions) =>
        this.#pages<User>('/users', options, pagination),
    }
    this.lists = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/lists/${encodeURIComponent(id)}`, options),
      create: (data: ListCreate, options?: MutationOptions) =>
        this.#create<List>('/lists', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<List>(`/lists/${encodeURIComponent(id)}`, options),
      list: (options?: ListLookupListOptions) => this.#page<List>('/lists', options),
      pages: (options?: ListLookupListOptions, pagination?: PaginationOptions) =>
        this.#pages<List>('/lists', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<List>(`/lists/${encodeURIComponent(id)}/restore`, undefined, options),
      update: (id: string, data: ListUpdate, options?: RequestOptions) =>
        this.#update<List>(`/lists/${encodeURIComponent(id)}`, data, options),
    }
    this.services = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/services/${encodeURIComponent(id)}`, options),
      create: (data: ServiceCreate, options?: MutationOptions) =>
        this.#create<Service>('/services', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Service>(`/services/${encodeURIComponent(id)}`, options),
      list: (options?: LookupListOptions) => this.#page<Service>('/services', options),
      pages: (options?: LookupListOptions, pagination?: PaginationOptions) =>
        this.#pages<Service>('/services', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<Service>(`/services/${encodeURIComponent(id)}/restore`, undefined, options),
      update: (id: string, data: ServiceUpdate, options?: RequestOptions) =>
        this.#update<Service>(`/services/${encodeURIComponent(id)}`, data, options),
    }
    this.tags = {
      archive: (id: string, options?: RequestOptions) =>
        this.#archive(`/tags/${encodeURIComponent(id)}`, options),
      create: (data: TagCreate, options?: MutationOptions) =>
        this.#create<Tag>('/tags', data, options),
      get: (id: string, options?: RequestOptions) =>
        this.#resource<Tag>(`/tags/${encodeURIComponent(id)}`, options),
      list: (options?: LookupListOptions) => this.#page<Tag>('/tags', options),
      pages: (options?: LookupListOptions, pagination?: PaginationOptions) =>
        this.#pages<Tag>('/tags', options, pagination),
      restore: (id: string, options?: RequestOptions) =>
        this.#action<Tag>(`/tags/${encodeURIComponent(id)}/restore`, undefined, options),
      update: (id: string, data: TagUpdate, options?: RequestOptions) =>
        this.#update<Tag>(`/tags/${encodeURIComponent(id)}`, data, options),
    }
    this.auditEvents = {
      list: (options?: AuditEventListOptions) => this.#page<AuditEvent>('/audit-events', options),
      pages: (options?: AuditEventListOptions, pagination?: PaginationOptions) =>
        this.#pages<AuditEvent>('/audit-events', options, pagination),
    }
    this.webhookDeliveries = {
      get: (id: string, options?: RequestOptions) =>
        this.#resource<WebhookDelivery>(`/webhook-deliveries/${encodeURIComponent(id)}`, options),
      list: (options?: WebhookDeliveryListOptions) =>
        this.#page<WebhookDelivery>('/webhook-deliveries', options),
      pages: (options?: WebhookDeliveryListOptions, pagination?: PaginationOptions) =>
        this.#pages<WebhookDelivery>('/webhook-deliveries', options, pagination),
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

  async #request(path: string, options: InternalRequestOptions = {}): Promise<InternalResponse> {
    const method = options.method || 'GET'
    const url = new URL(`${this.#baseUrl}${path}`)
    addQuery(url, options.query)
    const requestId = options.requestId || newRequestId()
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
      'x-teamgrid-client': '@teamgrid/api-client',
      'x-teamgrid-client-version': apiClientVersion,
      'x-request-id': requestId,
    })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)
    if (options.ifMatch) headers.set('if-match', options.ifMatch)

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
      const envelope = isObject(payload) ? payload : {}
      const responseRequestId =
        isObject(envelope.meta) && typeof envelope.meta.requestId === 'string'
          ? envelope.meta.requestId
          : response.headers.get('x-request-id') || requestId
      const transport = transportMetadata({
        attempts: attempt + 1,
        fallbackRequestId: responseRequestId,
        response,
        retryAfterMs,
      })
      if (!response.ok) {
        throw new TeamGridApiError({
          errors: Array.isArray(envelope.errors) ? envelope.errors : undefined,
          requestId: responseRequestId,
          retryAfterMs,
          status: response.status,
          transport,
        })
      }
      return { payload, transport }
    }
    throw new TeamGridClientError('retry_exhausted', 'The TeamGrid API retry budget was exhausted.')
  }

  async #waitForProjectLifecycleOperation(id: string, options: ProjectLifecycleWaitOptions = {}) {
    const pollIntervalMs = Math.max(
      100,
      Math.min(Math.trunc(options.pollIntervalMs ?? 1000), 30_000),
    )
    const maxWaitMs = Math.max(100, Math.min(Math.trunc(options.maxWaitMs ?? 300_000), 86_400_000))
    const startedAt = Date.now()
    while (true) {
      const operation = await this.projectLifecycleOperations.get(id, options)
      if (
        operation.data.attributes.state === 'succeeded' ||
        operation.data.attributes.state === 'failed'
      ) {
        return operation
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= maxWaitMs) {
        throw new TeamGridClientError(
          'lifecycle_wait_timeout',
          `Project lifecycle operation ${id} did not finish within ${maxWaitMs} ms.`,
        )
      }
      await this.#sleep(Math.min(pollIntervalMs, maxWaitMs - elapsed), options.signal)
    }
  }

  async #waitForProjectTemplateInstantiation(
    id: string,
    options: ProjectTemplateInstantiationWaitOptions = {},
  ) {
    const pollIntervalMs = Math.max(
      100,
      Math.min(Math.trunc(options.pollIntervalMs ?? 1000), 30_000),
    )
    const maxWaitMs = Math.max(100, Math.min(Math.trunc(options.maxWaitMs ?? 300_000), 86_400_000))
    const startedAt = Date.now()
    while (true) {
      const operation = await this.projectTemplateInstantiations.get(id, options)
      if (
        operation.data.attributes.state === 'succeeded' ||
        operation.data.attributes.state === 'failed'
      ) {
        return operation
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= maxWaitMs) {
        throw new TeamGridClientError(
          'project_template_instantiation_wait_timeout',
          `Project-template instantiation ${id} did not finish within ${maxWaitMs} ms.`,
        )
      }
      await this.#sleep(Math.min(pollIntervalMs, maxWaitMs - elapsed), options.signal)
    }
  }

  async #waitForPlannedWorkOperation(id: string, options: PlannedWorkOperationWaitOptions = {}) {
    const pollIntervalMs = Math.max(
      100,
      Math.min(Math.trunc(options.pollIntervalMs ?? 1000), 30_000),
    )
    const maxWaitMs = Math.max(100, Math.min(Math.trunc(options.maxWaitMs ?? 300_000), 86_400_000))
    const startedAt = Date.now()
    while (true) {
      const operation = await this.plannedWorkOperations.get(id, options)
      if (
        operation.data.attributes.state === 'succeeded' ||
        operation.data.attributes.state === 'failed'
      ) {
        return operation
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= maxWaitMs) {
        throw new TeamGridClientError(
          'planned_work_operation_wait_timeout',
          `Planned-work operation ${id} did not finish within ${maxWaitMs} ms.`,
        )
      }
      await this.#sleep(Math.min(pollIntervalMs, maxWaitMs - elapsed), options.signal)
    }
  }

  #retryDelay(attempt: number) {
    return Math.min(250 * 2 ** attempt + Math.floor(this.#random() * 100), maxRetryDelayMs)
  }

  async #resource<T>(path: string, options?: RequestOptions) {
    const response = await this.#request(path, options)
    return attachTransport(
      assertResource<T>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #page<T>(path: string, options: ListOptions & Record<string, unknown> = {}) {
    const { requestId, signal, ...query } = options
    const response = await this.#request(path, {
      query: query as Query,
      requestId,
      signal,
    })
    return attachTransport(
      assertPage<T>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #changePage(options: ChangeListOptions = {}) {
    const { requestId, signal, ...query } = options
    const response = await this.#request('/changes', {
      query: query as Query,
      requestId,
      signal,
    })
    return attachTransport(assertChangePage(response.payload), response.transport)
  }

  async #customFieldValueMutation(
    path: string,
    method: 'DELETE' | 'PUT',
    data: unknown,
    options: CustomFieldValueMutationOptions,
  ) {
    const { ifMatch, ...requestOptions } = options
    const response = await this.#request(path, {
      ...requestOptions,
      ...(data === undefined ? {} : { body: data }),
      ifMatch: strongCustomFieldValueEtag(ifMatch),
      method,
    })
    return attachTransport(
      assertResource<CustomFieldValueMutation>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #replaceTaskPlannedWork(
    id: string,
    data: PlannedWorkReplacement,
    options: PlannedWorkReplaceOptions,
  ) {
    const { ifMatch, ...requestOptions } = options
    const response = await this.#request(`/tasks/${encodeURIComponent(id)}/planned-work`, {
      ...requestOptions,
      body: data,
      idempotencyKey: requestOptions.idempotencyKey || newRequestId(),
      ifMatch: strongPlannedWorkEtag(ifMatch),
      method: 'PUT',
    })
    return attachTransport(
      assertResource<PlannedWorkOperation>(response.payload, ['plannedWorkOperation']),
      response.transport,
    )
  }

  async *#changePages(
    options: ChangeCatchUpOptions = {},
    pagination: PaginationOptions = {},
  ): AsyncIterable<ChangePageEnvelope> {
    let cursor = options.cursor
    const seen = new Set<string>(cursor ? [cursor] : [])
    const maxPages = Math.max(1, Math.min(Math.trunc(pagination.maxPages ?? 10_000), 10_000))
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.#changePage({
        ...options,
        cursor,
        signal: pagination.signal || options.signal,
      })
      yield page
      if (page.meta.page.caughtUp) return
      const nextCursor = page.meta.page.nextCursor
      if (seen.has(nextCursor)) {
        throw new TeamGridClientError(
          'pagination_cycle',
          'The TeamGrid API returned a repeated change-feed cursor.',
        )
      }
      seen.add(nextCursor)
      cursor = nextCursor
    }
    throw new TeamGridClientError(
      'pagination_limit',
      `Change-feed catch-up exceeded the configured ${maxPages}-page safety limit.`,
    )
  }

  async #snapshotThenCatchUp<T>(
    snapshot: (checkpoint: ChangeCheckpoint) => Promise<T>,
    options: ChangeFilterOptions = {},
    pagination: PaginationOptions = {},
  ): Promise<ChangeFeedBootstrap<T>> {
    const checkpointPage = await this.#changePage({ ...options, startAtLatest: true })
    if (checkpointPage.data.length !== 0 || !checkpointPage.meta.page.caughtUp) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'Expected an empty TeamGrid change-feed checkpoint page.',
      )
    }
    const checkpoint = checkpointPage.meta.page.nextCursor
    const snapshotValue = await snapshot(checkpoint)
    return {
      checkpoint,
      pages: this.#changePages({ ...options, cursor: checkpoint }, pagination),
      snapshot: snapshotValue,
    }
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
    const response = await this.#request(path, {
      ...options,
      body: data,
      idempotencyKey: options.idempotencyKey || newRequestId(),
      method: 'POST',
    })
    return attachTransport(
      assertResource<T>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #update<T>(path: string, data: unknown, options: RequestOptions = {}) {
    const response = await this.#request(path, {
      ...options,
      body: data,
      method: 'PATCH',
    })
    return attachTransport(
      assertResource<T>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #action<T>(path: string, data?: unknown, options: RequestOptions = {}) {
    const response = await this.#request(path, {
      ...options,
      ...(data === undefined ? {} : { body: data }),
      method: 'POST',
    })
    return attachTransport(
      assertResource<T>(response.payload, expectedResourceTypes(path)),
      response.transport,
    )
  }

  async #archive(path: string, options: RequestOptions = {}) {
    return (await this.#request(path, { ...options, method: 'DELETE' })).transport
  }
}

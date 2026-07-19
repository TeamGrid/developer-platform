import { TeamGridApiError, TeamGridClientError } from './errors.js'
import {
  absenceValidator,
  activityEventValidator,
  appointmentValidator,
  assertRevisionEtag,
  assertStrictPage,
  assertStrictResource,
  assertStrictResourceArray,
  automationActionValidator,
  automationDefinitionValidator,
  automationDefinitionVersionValidator,
  automationRunValidator,
  availabilityValidator,
  canonicalAdministrationEtag,
  canonicalAutomationDefinitionEtag,
  canonicalAutomationRunEtag,
  commentValidator,
  documentEtag,
  documentValidator,
  exportCreationValidator,
  exportDownloadIntentValidator,
  exportJobValidator,
  fileDownloadIntentValidator,
  fileEtag,
  fileUploadCancellationValidator,
  fileUploadIntentValidator,
  fileValidator,
  groupValidator,
  integrationInstallationValidator,
  invitationCreateValidator,
  invitationValidator,
  isDownloadIntentToken,
  isSafeExportFileName,
  memberValidator,
  roleValidator,
  searchResultValidator,
} from './newDomainValidation.js'
import { buildRegionalApiBaseUrl, normalizeApiBaseUrl, parseCredentialLocation } from './routing.js'
import type {
  AbsenceCreate,
  AbsenceMutationOptions,
  AbsenceUpdate,
  ActivityListOptions,
  AdministrationMutationOptions,
  AdministrationPiiOptions,
  ApiVersionEnvelope,
  AppointmentCreate,
  AppointmentMutationOptions,
  AppointmentUpdate,
  AuditEvent,
  AuditEventListOptions,
  AutomationDefinitionCreate,
  AutomationDefinitionListOptions,
  AutomationDefinitionMutationOptions,
  AutomationDefinitionUpdate,
  AutomationRunListOptions,
  AutomationRunMutationOptions,
  AvailabilityListOptions,
  CalendarListOptions,
  CallNote,
  CallNoteCreate,
  CallNoteListOptions,
  ChangeCatchUpOptions,
  ChangeCheckpoint,
  ChangeFeedBootstrap,
  ChangeFilterOptions,
  ChangeListOptions,
  ChangePageEnvelope,
  CommentCreate,
  CommentListOptions,
  CommentMutationOptions,
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
  DocumentCreate,
  DocumentListOptions,
  DocumentMutationOptions,
  DocumentUpdate,
  ExportCreate,
  ExportDownload,
  ExportDownloadOptions,
  FileGetOptions,
  FileListOptions,
  FileMutationOptions,
  FileRename,
  FileUploadIntentCreate,
  GroupCreate,
  GroupUpdate,
  InvitationCreate,
  InvitationListOptions,
  InvitationResendOptions,
  List,
  ListCreate,
  ListEnvelope,
  ListLookupListOptions,
  ListOptions,
  ListUpdate,
  LookupListOptions,
  MemberListOptions,
  MemberRoleUpdate,
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
  RoleCreate,
  RoleUpdate,
  SearchQuery,
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
type Query = Record<string, QueryValue | readonly QueryValue[]>

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
const maximumExportDownloadBytes = 50 * 1024 * 1024
const exportContentType = 'text/csv; charset=utf-8' as const

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

async function readBoundedResponseBytes(response: Response, maximumBytes: number) {
  const rawLength = response.headers.get('content-length')
  let expectedLength: number | undefined
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) {
      await response.body?.cancel()
      throw new TeamGridClientError(
        'invalid_api_response',
        'The TeamGrid export download returned an invalid Content-Length.',
      )
    }
    expectedLength = Number(rawLength)
    if (!Number.isSafeInteger(expectedLength) || expectedLength > maximumBytes) {
      await response.body?.cancel()
      throw new TeamGridClientError(
        'export_download_too_large',
        `The TeamGrid export download exceeded ${maximumBytes} bytes.`,
      )
    }
  }
  if (!response.body) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'The TeamGrid export download did not include a response body.',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maximumBytes) {
      await reader.cancel()
      throw new TeamGridClientError(
        'export_download_too_large',
        `The TeamGrid export download exceeded ${maximumBytes} bytes.`,
      )
    }
    chunks.push(value)
  }
  if (expectedLength !== undefined && received !== expectedLength) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'The TeamGrid export download did not match its Content-Length.',
    )
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function exportDownloadFileName(value: string | null) {
  if (!value || !/^attachment\s*;/i.test(value)) return null
  const utf8 = value.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)(?:;|$)/i)?.[1]
  if (!utf8) return null
  try {
    const fileName = decodeURIComponent(utf8)
    return isSafeExportFileName(fileName) ? fileName : null
  } catch {
    return null
  }
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

function strongResourceEtag(value: string, pattern: RegExp, label: string) {
  const revision = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  if (!pattern.test(revision)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      `${label} ifMatch must be a canonical revision or one strong ETag.`,
    )
  }
  return `"${revision}"`
}

const strongAppointmentEtag = (value: string) =>
  strongResourceEtag(value, /^ap1-[a-f0-9]{64}$/, 'Appointment')
const strongAbsenceEtag = (value: string) =>
  strongResourceEtag(value, /^ab1-[a-f0-9]{64}$/, 'Absence')
const strongCommentEtag = (value: string) =>
  strongResourceEtag(value, /^cmt1-[a-f0-9]{64}$/, 'Comment')
const strongDocumentEtag = (value: string) => {
  const etag = strongResourceEtag(value, /^doc1-[A-Za-z0-9_-]+$/, 'Document')
  const encoded = etag.slice('"doc1-'.length, -1)
  try {
    const padded = encoded
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const binary = globalThis.atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const updatedAt = new TextDecoder().decode(bytes)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)) throw new Error()
    const date = new Date(updatedAt)
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== updatedAt) throw new Error()
    if (documentEtag(updatedAt) !== etag) throw new Error()
    return etag
  } catch {
    throw new TeamGridClientError(
      'invalid_arguments',
      'Document ifMatch must contain one canonical document ETag.',
    )
  }
}
const strongFileEtag = (value: string) => strongResourceEtag(value, /^file-[1-9][0-9]*$/, 'File')

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
  if (/^\/file-upload-intents\/[^/]+\/finalize$/.test(path)) return ['file']
  if (/^\/file-upload-intents\/[^/]+$/.test(path)) return ['fileUploadIntent']
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
    absences: ['absence'],
    activity: ['activityEvent'],
    appointments: ['appointment'],
    'audit-events': ['auditEvent'],
    'call-notes': ['callNote'],
    changes: ['changeEvent'],
    comments: ['comment'],
    contacts: ['contact'],
    'contact-groups': ['contactGroup'],
    'custom-field-definitions': ['customFieldDefinition'],
    'custom-field-values': ['customFieldValue'],
    documents: ['document'],
    files: ['file', 'fileDownloadIntent'],
    'file-upload-intents': ['fileUploadIntent'],
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
    availability: ['availability'],
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
  readonly absences
  readonly activity
  readonly appointments
  readonly automationActions
  readonly automationDefinitions
  readonly automationDefinitionVersions
  readonly automationRuns
  readonly availability
  readonly auditEvents
  readonly callNotes
  readonly changes
  readonly comments
  readonly contacts
  readonly contactGroups
  readonly customFieldDefinitions
  readonly customFieldValues
  readonly documents
  readonly exports
  readonly files
  readonly fileUploadIntents
  readonly groups
  readonly integrationInstallations
  readonly invitations
  readonly lists
  readonly location
  readonly members
  readonly plannedWork
  readonly plannedWorkOperations
  readonly productGroups
  readonly products
  readonly projects
  readonly projectLifecycleOperations
  readonly projectStatements
  readonly projectTemplateInstantiations
  readonly projectTemplates
  readonly roles
  readonly search
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
    this.appointments = {
      archive: (id: string, options: AppointmentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/appointments/${encodeURIComponent(id)}`,
          appointmentValidator,
          'appointment archive',
          {
            ...requestOptions,
            ifMatch: strongAppointmentEtag(ifMatch),
            method: 'DELETE',
          },
          200,
          (item) => item.attributes.revision,
        )
      },
      create: (data: AppointmentCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/appointments',
          appointmentValidator,
          'appointment creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (item) => item.attributes.revision,
        ),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/appointments/${encodeURIComponent(id)}`,
          appointmentValidator,
          'appointment',
          options,
          200,
          (item) => item.attributes.revision,
        ),
      list: (options: CalendarListOptions) =>
        this.#strictPage('/appointments', appointmentValidator, 'appointment list', options),
      pages: (options: CalendarListOptions, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/appointments',
          appointmentValidator,
          'appointment list',
          options,
          pagination,
        ),
      restore: (id: string, options: AppointmentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/appointments/${encodeURIComponent(id)}/restore`,
          appointmentValidator,
          'appointment restore',
          {
            ...requestOptions,
            ifMatch: strongAppointmentEtag(ifMatch),
            method: 'POST',
          },
          200,
          (item) => item.attributes.revision,
        )
      },
      update: (id: string, data: AppointmentUpdate, options: AppointmentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/appointments/${encodeURIComponent(id)}`,
          appointmentValidator,
          'appointment update',
          {
            ...requestOptions,
            body: data,
            ifMatch: strongAppointmentEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (item) => item.attributes.revision,
        )
      },
    }
    this.absences = {
      archive: (id: string, options: AbsenceMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/absences/${encodeURIComponent(id)}`,
          absenceValidator,
          'absence archive',
          { ...requestOptions, ifMatch: strongAbsenceEtag(ifMatch), method: 'DELETE' },
          200,
          (item) => item.attributes.revision,
        )
      },
      create: (data: AbsenceCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/absences',
          absenceValidator,
          'absence creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (item) => item.attributes.revision,
        ),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/absences/${encodeURIComponent(id)}`,
          absenceValidator,
          'absence',
          options,
          200,
          (item) => item.attributes.revision,
        ),
      list: (options: CalendarListOptions) =>
        this.#strictPage('/absences', absenceValidator, 'absence list', options),
      pages: (options: CalendarListOptions, pagination?: PaginationOptions) =>
        this.#strictPages('/absences', absenceValidator, 'absence list', options, pagination),
      restore: (id: string, options: AbsenceMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/absences/${encodeURIComponent(id)}/restore`,
          absenceValidator,
          'absence restore',
          { ...requestOptions, ifMatch: strongAbsenceEtag(ifMatch), method: 'POST' },
          200,
          (item) => item.attributes.revision,
        )
      },
      update: (id: string, data: AbsenceUpdate, options: AbsenceMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/absences/${encodeURIComponent(id)}`,
          absenceValidator,
          'absence update',
          {
            ...requestOptions,
            body: data,
            ifMatch: strongAbsenceEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (item) => item.attributes.revision,
        )
      },
    }
    this.availability = {
      list: async (options: AvailabilityListOptions) => {
        const { requestId, signal, ...query } = options
        return this.#strictResource('/availability', availabilityValidator, 'availability', {
          query: query as Query,
          requestId,
          signal,
        })
      },
    }
    this.activity = {
      list: (options: ActivityListOptions) =>
        this.#strictPage('/activity', activityEventValidator, 'activity list', options),
      pages: (options: ActivityListOptions, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/activity',
          activityEventValidator,
          'activity list',
          options,
          pagination,
        ),
    }
    this.comments = {
      archive: (id: string, options: CommentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/comments/${encodeURIComponent(id)}`,
          commentValidator,
          'comment archive',
          { ...requestOptions, ifMatch: strongCommentEtag(ifMatch), method: 'DELETE' },
          200,
          (item) => item.attributes.revision,
        )
      },
      create: (data: CommentCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/comments',
          commentValidator,
          'comment creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (item) => item.attributes.revision,
        ),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/comments/${encodeURIComponent(id)}`,
          commentValidator,
          'comment',
          options,
          200,
          (item) => item.attributes.revision,
        ),
      list: (options: CommentListOptions) =>
        this.#strictPage('/comments', commentValidator, 'comment list', options),
      pages: (options: CommentListOptions, pagination?: PaginationOptions) =>
        this.#strictPages('/comments', commentValidator, 'comment list', options, pagination),
      restore: (id: string, options: CommentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/comments/${encodeURIComponent(id)}/restore`,
          commentValidator,
          'comment restore',
          { ...requestOptions, ifMatch: strongCommentEtag(ifMatch), method: 'POST' },
          200,
          (item) => item.attributes.revision,
        )
      },
    }
    this.documents = {
      archive: (id: string, options: DocumentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/documents/${encodeURIComponent(id)}`,
          documentValidator('optional'),
          'document archive',
          { ...requestOptions, ifMatch: strongDocumentEtag(ifMatch), method: 'DELETE' },
          200,
          undefined,
          (item) => documentEtag(item.attributes.updatedAt),
        )
      },
      create: (data: DocumentCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/documents',
          documentValidator('required'),
          'document creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          undefined,
          (item) => documentEtag(item.attributes.updatedAt),
        ),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/documents/${encodeURIComponent(id)}`,
          documentValidator('required'),
          'document',
          options,
          200,
          undefined,
          (item) => documentEtag(item.attributes.updatedAt),
        ),
      list: (options: DocumentListOptions = {}) =>
        this.#strictPage('/documents', documentValidator('absent'), 'document list', options),
      pages: (options: DocumentListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/documents',
          documentValidator('absent'),
          'document list',
          options,
          pagination,
        ),
      restore: (id: string, options: DocumentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/documents/${encodeURIComponent(id)}/restore`,
          documentValidator('optional'),
          'document restore',
          { ...requestOptions, ifMatch: strongDocumentEtag(ifMatch), method: 'POST' },
          200,
          undefined,
          (item) => documentEtag(item.attributes.updatedAt),
        )
      },
      update: (id: string, data: DocumentUpdate, options: DocumentMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/documents/${encodeURIComponent(id)}`,
          documentValidator('required'),
          'document update',
          {
            ...requestOptions,
            body: data,
            ifMatch: strongDocumentEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          undefined,
          (item) => documentEtag(item.attributes.updatedAt),
        )
      },
    }
    this.files = {
      archive: (id: string, options: FileMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/files/${encodeURIComponent(id)}`,
          fileValidator,
          'file archive',
          { ...requestOptions, ifMatch: strongFileEtag(ifMatch), method: 'DELETE' },
          200,
          undefined,
          (item) => fileEtag(item.attributes.syncRevision),
        )
      },
      createDownloadIntent: (id: string, options: RequestOptions = {}) =>
        this.#strictResource(
          `/files/${encodeURIComponent(id)}/download-intent`,
          fileDownloadIntentValidator,
          'file download intent',
          { ...options, method: 'POST' },
          201,
        ),
      get: async (id: string, options: FileGetOptions = {}) => {
        const { archived, ...requestOptions } = options
        return this.#strictResource(
          `/files/${encodeURIComponent(id)}`,
          fileValidator,
          'file',
          { ...requestOptions, ...(archived === undefined ? {} : { query: { archived } }) },
          200,
          undefined,
          (item) => fileEtag(item.attributes.syncRevision),
        )
      },
      list: (options: FileListOptions = {}) =>
        this.#strictPage('/files', fileValidator, 'file list', options),
      pages: (options: FileListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages('/files', fileValidator, 'file list', options, pagination),
      rename: (id: string, data: FileRename, options: FileMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/files/${encodeURIComponent(id)}`,
          fileValidator,
          'file rename',
          {
            ...requestOptions,
            body: data,
            ifMatch: strongFileEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          undefined,
          (item) => fileEtag(item.attributes.syncRevision),
        )
      },
      restore: (id: string, options: FileMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/files/${encodeURIComponent(id)}/restore`,
          fileValidator,
          'file restore',
          { ...requestOptions, ifMatch: strongFileEtag(ifMatch), method: 'POST' },
          200,
          undefined,
          (item) => fileEtag(item.attributes.syncRevision),
        )
      },
    }
    this.fileUploadIntents = {
      cancel: (id: string, options: RequestOptions = {}) =>
        this.#strictResource(
          `/file-upload-intents/${encodeURIComponent(id)}`,
          fileUploadCancellationValidator,
          'file upload cancellation',
          { ...options, method: 'DELETE' },
        ),
      create: (data: FileUploadIntentCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/file-upload-intents',
          fileUploadIntentValidator,
          'file upload intent',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
        ),
      finalize: (id: string, options: RequestOptions = {}) =>
        this.#strictResource(
          `/file-upload-intents/${encodeURIComponent(id)}/finalize`,
          fileValidator,
          'file upload finalization',
          { ...options, method: 'POST' },
          200,
          undefined,
          (item) => fileEtag(item.attributes.syncRevision),
        ),
    }
    this.members = {
      get: (id: string, options: AdministrationPiiOptions = {}) => {
        const { includePii, ...requestOptions } = options
        return this.#strictResource(
          `/members/${encodeURIComponent(id)}`,
          memberValidator(includePii === true),
          'member',
          {
            ...requestOptions,
            ...(includePii === undefined ? {} : { query: { includePii } }),
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
      list: (options: MemberListOptions = {}) =>
        this.#strictPage(
          '/members',
          memberValidator(options.includePii === true),
          'member list',
          options,
        ),
      pages: (options: MemberListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/members',
          memberValidator(options.includePii === true),
          'member list',
          options,
          pagination,
        ),
      remove: (id: string, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictNoContent(`/members/${encodeURIComponent(id)}`, {
          ...requestOptions,
          ifMatch: canonicalAdministrationEtag(ifMatch),
          method: 'DELETE',
        })
      },
      updateRole: (id: string, data: MemberRoleUpdate, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/members/${encodeURIComponent(id)}/role`,
          memberValidator(false),
          'member role update',
          {
            ...requestOptions,
            body: data,
            ifMatch: canonicalAdministrationEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
    }
    this.invitations = {
      cancel: (id: string, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictNoContent(`/invitations/${encodeURIComponent(id)}`, {
          ...requestOptions,
          ifMatch: canonicalAdministrationEtag(ifMatch),
          method: 'DELETE',
        })
      },
      create: (data: InvitationCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/invitations',
          invitationCreateValidator,
          'invitation creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (resource) => resource.attributes.revision,
        ),
      get: (id: string, options: AdministrationPiiOptions = {}) => {
        const { includePii, ...requestOptions } = options
        return this.#strictResource(
          `/invitations/${encodeURIComponent(id)}`,
          invitationValidator(includePii === true),
          'invitation',
          {
            ...requestOptions,
            ...(includePii === undefined ? {} : { query: { includePii } }),
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
      list: (options: InvitationListOptions = {}) =>
        this.#strictPage(
          '/invitations',
          invitationValidator(options.includePii === true),
          'invitation list',
          options,
        ),
      pages: (options: InvitationListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/invitations',
          invitationValidator(options.includePii === true),
          'invitation list',
          options,
          pagination,
        ),
      resend: (id: string, options: InvitationResendOptions) => {
        const { idempotencyKey, ifMatch, ...requestOptions } = options
        return this.#strictNoContent(
          `/invitations/${encodeURIComponent(id)}/resend`,
          {
            ...requestOptions,
            idempotencyKey: idempotencyKey || newRequestId(),
            ifMatch: canonicalAdministrationEtag(ifMatch),
            method: 'POST',
          },
          true,
        )
      },
    }
    this.roles = {
      create: (data: RoleCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/roles',
          roleValidator,
          'role creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (resource) => resource.attributes.revision,
        ),
      remove: (id: string, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictNoContent(`/roles/${encodeURIComponent(id)}`, {
          ...requestOptions,
          ifMatch: canonicalAdministrationEtag(ifMatch),
          method: 'DELETE',
        })
      },
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/roles/${encodeURIComponent(id)}`,
          roleValidator,
          'role',
          options,
          200,
          (resource) => resource.attributes.revision,
        ),
      list: (options: ListOptions = {}) =>
        this.#strictPage('/roles', roleValidator, 'role list', options),
      pages: (options: ListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages('/roles', roleValidator, 'role list', options, pagination),
      update: (id: string, data: RoleUpdate, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/roles/${encodeURIComponent(id)}`,
          roleValidator,
          'role update',
          {
            ...requestOptions,
            body: data,
            ifMatch: canonicalAdministrationEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
    }
    this.groups = {
      create: (data: GroupCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/groups',
          groupValidator,
          'group creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (resource) => resource.attributes.revision,
        ),
      remove: (id: string, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictNoContent(`/groups/${encodeURIComponent(id)}`, {
          ...requestOptions,
          ifMatch: canonicalAdministrationEtag(ifMatch),
          method: 'DELETE',
        })
      },
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/groups/${encodeURIComponent(id)}`,
          groupValidator,
          'group',
          options,
          200,
          (resource) => resource.attributes.revision,
        ),
      list: (options: ListOptions = {}) =>
        this.#strictPage('/groups', groupValidator, 'group list', options),
      pages: (options: ListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages('/groups', groupValidator, 'group list', options, pagination),
      update: (id: string, data: GroupUpdate, options: AdministrationMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/groups/${encodeURIComponent(id)}`,
          groupValidator,
          'group update',
          {
            ...requestOptions,
            body: data,
            ifMatch: canonicalAdministrationEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
    }
    this.search = {
      query: (data: SearchQuery, options: RequestOptions = {}) =>
        this.#strictResourceArray('/search', searchResultValidator, 'search', 50, {
          ...options,
          body: data,
          method: 'POST',
        }),
    }
    this.exports = {
      create: (data: ExportCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/exports',
          exportCreationValidator,
          'export creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
        ),
      createDownloadIntent: (id: string, options: RequestOptions = {}) =>
        this.#strictResource(
          `/exports/${encodeURIComponent(id)}/download-intent`,
          exportDownloadIntentValidator,
          'export download intent',
          { ...options, method: 'POST' },
          201,
        ),
      download: (id: string, options: ExportDownloadOptions) => this.#downloadExport(id, options),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/exports/${encodeURIComponent(id)}`,
          exportJobValidator,
          'export job',
          options,
        ),
    }
    this.automationActions = {
      list: (options: RequestOptions = {}) =>
        this.#strictResourceArray(
          '/automation-actions',
          automationActionValidator,
          'automation action list',
          29,
          options,
        ),
    }
    this.automationDefinitions = {
      archive: (id: string, options: AutomationDefinitionMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/automation-definitions/${encodeURIComponent(id)}`,
          automationDefinitionValidator('required'),
          'automation definition archive',
          {
            ...requestOptions,
            ifMatch: canonicalAutomationDefinitionEtag(ifMatch),
            method: 'DELETE',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
      create: (data: AutomationDefinitionCreate, options: MutationOptions = {}) =>
        this.#strictResource(
          '/automation-definitions',
          automationDefinitionValidator('required'),
          'automation definition creation',
          {
            ...options,
            body: data,
            idempotencyKey: options.idempotencyKey || newRequestId(),
            method: 'POST',
          },
          201,
          (resource) => resource.attributes.revision,
        ),
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/automation-definitions/${encodeURIComponent(id)}`,
          automationDefinitionValidator('absent'),
          'automation definition',
          options,
          200,
          (resource) => resource.attributes.revision,
        ),
      list: (options: AutomationDefinitionListOptions = {}) =>
        this.#strictPage(
          '/automation-definitions',
          automationDefinitionValidator('absent'),
          'automation definition list',
          options,
        ),
      pages: (options: AutomationDefinitionListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/automation-definitions',
          automationDefinitionValidator('absent'),
          'automation definition list',
          options,
          pagination,
        ),
      restore: (id: string, options: AutomationDefinitionMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/automation-definitions/${encodeURIComponent(id)}/restore`,
          automationDefinitionValidator('required'),
          'automation definition restore',
          {
            ...requestOptions,
            ifMatch: canonicalAutomationDefinitionEtag(ifMatch),
            method: 'POST',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
      update: (
        id: string,
        data: AutomationDefinitionUpdate,
        options: AutomationDefinitionMutationOptions,
      ) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/automation-definitions/${encodeURIComponent(id)}`,
          automationDefinitionValidator('required'),
          'automation definition update',
          {
            ...requestOptions,
            body: data,
            ifMatch: canonicalAutomationDefinitionEtag(ifMatch),
            method: 'PATCH',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
    }
    this.automationDefinitionVersions = {
      list: (id: string, options: ListOptions = {}) =>
        this.#strictPage(
          `/automation-definitions/${encodeURIComponent(id)}/versions`,
          automationDefinitionVersionValidator,
          'automation definition version list',
          options,
        ),
      pages: (id: string, options: ListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          `/automation-definitions/${encodeURIComponent(id)}/versions`,
          automationDefinitionVersionValidator,
          'automation definition version list',
          options,
          pagination,
        ),
    }
    this.automationRuns = {
      abort: (id: string, options: AutomationRunMutationOptions) => {
        const { ifMatch, ...requestOptions } = options
        return this.#strictResource(
          `/automation-runs/${encodeURIComponent(id)}/abort`,
          automationRunValidator('required'),
          'automation run abort',
          {
            ...requestOptions,
            ifMatch: canonicalAutomationRunEtag(ifMatch),
            method: 'POST',
          },
          200,
          (resource) => resource.attributes.revision,
        )
      },
      get: (id: string, options?: RequestOptions) =>
        this.#strictResource(
          `/automation-runs/${encodeURIComponent(id)}`,
          automationRunValidator('absent'),
          'automation run',
          options,
          200,
          (resource) => resource.attributes.revision,
        ),
      list: (options: AutomationRunListOptions = {}) =>
        this.#strictPage(
          '/automation-runs',
          automationRunValidator('absent'),
          'automation run list',
          options,
        ),
      pages: (options: AutomationRunListOptions = {}, pagination?: PaginationOptions) =>
        this.#strictPages(
          '/automation-runs',
          automationRunValidator('absent'),
          'automation run list',
          options,
          pagination,
        ),
    }
    this.integrationInstallations = {
      list: (options: RequestOptions = {}) =>
        this.#strictResourceArray(
          '/integration-installations',
          integrationInstallationValidator,
          'integration installation list',
          100,
          options,
        ),
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

  async #strictResource<T>(
    path: string,
    validator: (value: unknown) => value is T,
    label: string,
    options: InternalRequestOptions = {},
    expectedStatus = 200,
    revision?: (resource: T) => string,
    expectedEtag?: (resource: T) => string | null,
  ) {
    const response = await this.#request(path, options)
    if (response.transport.status !== expectedStatus) {
      throw new TeamGridClientError(
        'invalid_api_response',
        `The TeamGrid API returned an unexpected status for ${label}.`,
      )
    }
    const envelope = assertStrictResource(response.payload, validator, label)
    if (revision) assertRevisionEtag(response.transport, revision(envelope.data), label)
    if (expectedEtag) {
      const expected = expectedEtag(envelope.data)
      if (!expected || response.transport.headers.etag !== expected) {
        throw new TeamGridClientError(
          'invalid_api_response',
          `The TeamGrid API returned an invalid ${label} ETag.`,
        )
      }
    }
    return attachTransport(envelope, response.transport)
  }

  async #strictResourceArray<T>(
    path: string,
    validator: (value: unknown) => value is T,
    label: string,
    maximum: number,
    options: InternalRequestOptions = {},
  ) {
    const response = await this.#request(path, options)
    if (response.transport.status !== 200) {
      throw new TeamGridClientError(
        'invalid_api_response',
        `The TeamGrid API returned an unexpected status for ${label}.`,
      )
    }
    return attachTransport(
      assertStrictResourceArray(response.payload, validator, label, maximum),
      response.transport,
    )
  }

  async #strictPage<T>(
    path: string,
    validator: (value: unknown) => value is T,
    label: string,
    options: ListOptions & Record<string, unknown> = {},
  ) {
    const { requestId, signal, ...query } = options
    const response = await this.#request(path, {
      query: query as Query,
      requestId,
      signal,
    })
    if (response.transport.status !== 200) {
      throw new TeamGridClientError(
        'invalid_api_response',
        `The TeamGrid API returned an unexpected status for ${label}.`,
      )
    }
    return attachTransport(assertStrictPage(response.payload, validator, label), response.transport)
  }

  async *#strictPages<T>(
    path: string,
    validator: (value: unknown) => value is T,
    label: string,
    options: ListOptions & Record<string, unknown> = {},
    pagination: PaginationOptions = {},
  ) {
    let cursor = options.cursor
    const seen = new Set<string>()
    const maxPages = Math.max(1, Math.min(Math.trunc(pagination.maxPages ?? 10_000), 10_000))
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.#strictPage(path, validator, label, {
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

  async #strictNoContent(
    path: string,
    options: InternalRequestOptions,
    requireIdempotencyReplay = false,
  ) {
    const response = await this.#request(path, options)
    if (
      response.transport.status !== 204 ||
      response.payload !== undefined ||
      (requireIdempotencyReplay && response.transport.idempotencyReplayed === undefined)
    ) {
      throw new TeamGridClientError(
        'invalid_api_response',
        'The TeamGrid API returned an invalid empty mutation response.',
      )
    }
    return response.transport
  }

  async #downloadExport(id: string, options: ExportDownloadOptions): Promise<ExportDownload> {
    const { intentToken, maxBytes = maximumExportDownloadBytes, requestId, signal } = options
    if (!isDownloadIntentToken(intentToken)) {
      throw new TeamGridClientError(
        'invalid_arguments',
        'The export download intent token is invalid.',
      )
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumExportDownloadBytes) {
      throw new TeamGridClientError(
        'invalid_arguments',
        'Export maxBytes must be an integer between 1 and 52428800.',
      )
    }
    const resolvedRequestId = requestId || newRequestId()
    const url = new URL(`${this.#baseUrl}/exports/${encodeURIComponent(id)}/download`)
    const headers = new Headers({
      accept: 'text/csv',
      authorization: `Bearer ${this.#token}`,
      'x-teamgrid-client': '@teamgrid/api-client',
      'x-teamgrid-client-version': apiClientVersion,
      'x-teamgrid-export-download-intent': intentToken,
      'x-request-id': resolvedRequestId,
    })
    const combined = buildCombinedSignal(signal, this.#timeoutMs)
    try {
      let response: Response
      try {
        response = await this.#fetch(url, {
          headers,
          method: 'GET',
          redirect: 'manual',
          signal: combined.signal,
        })
      } catch (error) {
        if (error instanceof TeamGridClientError) throw error
        throw new TeamGridClientError(
          combined.signal.aborted ? 'request_aborted' : 'network_error',
          combined.signal.aborted
            ? 'The TeamGrid export download was aborted.'
            : 'The TeamGrid export download could not reach the service.',
          { cause: error },
        )
      }
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      const transport = transportMetadata({
        attempts: 1,
        fallbackRequestId: response.headers.get('x-request-id') || resolvedRequestId,
        response,
        retryAfterMs,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new TeamGridClientError(
          'unexpected_redirect',
          'The TeamGrid export download refused an HTTP redirect.',
        )
      }
      if (response.status !== 200) {
        const text = await readBoundedResponseText(response, this.#maxResponseBytes)
        let payload: unknown
        try {
          payload = text ? (JSON.parse(text) as unknown) : undefined
        } catch {
          payload = undefined
        }
        const envelope = isObject(payload) ? payload : {}
        const responseRequestId =
          isObject(envelope.meta) && typeof envelope.meta.requestId === 'string'
            ? envelope.meta.requestId
            : transport.requestId
        throw new TeamGridApiError({
          errors: Array.isArray(envelope.errors) ? envelope.errors : undefined,
          requestId: responseRequestId,
          retryAfterMs,
          status: response.status,
          transport,
        })
      }
      if (
        response.headers.get('content-type')?.toLowerCase() !== exportContentType ||
        response.headers.get('cache-control')?.toLowerCase() !== 'private, no-store' ||
        response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff'
      ) {
        await response.body?.cancel()
        throw new TeamGridClientError(
          'invalid_api_response',
          'The TeamGrid export download returned unsafe response headers.',
        )
      }
      const fileName = exportDownloadFileName(response.headers.get('content-disposition'))
      if (!fileName) {
        await response.body?.cancel()
        throw new TeamGridClientError(
          'invalid_api_response',
          'The TeamGrid export download returned an invalid file name.',
        )
      }
      const data = await readBoundedResponseBytes(response, maxBytes)
      return attachTransport({ contentType: exportContentType, data, fileName }, transport)
    } finally {
      combined.cleanup()
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

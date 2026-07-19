import type { components } from './generated/schema.js'

export type Workspace = components['schemas']['Workspace']
export type ApiVersion = components['schemas']['ApiVersionEnvelope']['data']
export type ApiVersionEnvelope = components['schemas']['ApiVersionEnvelope'] & TransportAware
export type Project = components['schemas']['Project']
export type ProjectCreate = components['schemas']['ProjectCreate']
export type ProjectUpdate = components['schemas']['ProjectUpdate']
export type Product = components['schemas']['Product']
export type ProductCreate = components['schemas']['ProductCreate']
export type ProductUpdate = components['schemas']['ProductUpdate']
export type ProductGroup = components['schemas']['ProductGroup']
export type ProductGroupCreate = components['schemas']['ProductGroupCreate']
export type ProductGroupUpdate = components['schemas']['ProductGroupUpdate']
export type ProjectStatement = components['schemas']['ProjectStatement']
export type ProjectStatementCreate = components['schemas']['ProjectStatementCreate']
export type ProjectStatementUpdate = components['schemas']['ProjectStatementUpdate']
export type Task = components['schemas']['Task']
export type TimeEntry = components['schemas']['TimeEntry']
export type Contact = components['schemas']['Contact']
export type ContactCreate = components['schemas']['ContactCreate']
export type ContactUpdate = components['schemas']['ContactUpdate']
export type CallNote = components['schemas']['CallNote']
export type CallNoteCreate = components['schemas']['CallNoteCreate']
export type ContactGroup = components['schemas']['ContactGroup']
export type ContactGroupCreate = components['schemas']['ContactGroupCreate']
export type ContactGroupUpdate = components['schemas']['ContactGroupUpdate']
export type CustomFieldDefinition = components['schemas']['CustomFieldDefinition']
export type CustomFieldDefinitionCreate = components['schemas']['CustomFieldDefinitionCreate']
export type CustomFieldDefinitionUpdate = components['schemas']['CustomFieldDefinitionUpdate']
export type CustomFieldValue = components['schemas']['CustomFieldValue']
export type CustomFieldValueMutation = components['schemas']['CustomFieldValueMutation']
export type CustomFieldValueSet = components['schemas']['CustomFieldValueSet']
export type CustomFieldValueTargetType = CustomFieldValue['attributes']['targetType']
export type CustomFieldValueRevision = CustomFieldValue['attributes']['revision']
export type ProjectTemplate = components['schemas']['ProjectTemplate']
export type ProjectTemplateCreate = components['schemas']['ProjectTemplateCreate']
export type ProjectTemplateUpdate = components['schemas']['ProjectTemplateUpdate']
export type ProjectTemplateInstantiate = components['schemas']['ProjectTemplateInstantiate']
export type ProjectTemplateInstantiation = components['schemas']['ProjectTemplateInstantiation']
export type PlannedWork = components['schemas']['PlannedWork']
export type PlannedWorkReplacement = components['schemas']['PlannedWorkReplacement']
export type PlannedWorkOperation = components['schemas']['PlannedWorkOperation']
export type TaskPlannedWork = components['schemas']['TaskPlannedWork']
export type PlannedWorkRevision = TaskPlannedWork['attributes']['revision']
export type User = components['schemas']['User']
export type List = components['schemas']['List']
export type ListCreate = components['schemas']['ListCreate']
export type ListUpdate = components['schemas']['ListUpdate']
export type Service = components['schemas']['Service']
export type ServiceCreate = components['schemas']['ServiceCreate']
export type ServiceUpdate = components['schemas']['ServiceUpdate']
export type Tag = components['schemas']['Tag']
export type TagCreate = components['schemas']['TagCreate']
export type TagUpdate = components['schemas']['TagUpdate']
export type Lookup = List | Service | Tag
export type AuditEvent = components['schemas']['AuditEvent']
export type ChangeEvent = components['schemas']['ChangeEvent']
export type ChangeOperation = ChangeEvent['attributes']['operation']
export type ChangeResourceType = ChangeEvent['attributes']['resourceType']
/**
 * An opaque, credential- and cell-bound change-feed checkpoint. Persist the
 * value verbatim and return it only to the same regional endpoint with the
 * same credential and filters.
 */
export type ChangeCheckpoint = string
export type Webhook = components['schemas']['Webhook']
export type WebhookCreate = components['schemas']['WebhookCreate']
export type WebhookDelivery = components['schemas']['WebhookDelivery']
export type TaskCreate = components['schemas']['TaskCreate']
export type TaskUpdate = components['schemas']['TaskUpdate']
export type TimeEntryCreate = components['schemas']['TimeEntryCreate']
export type TimeEntryUpdate = components['schemas']['TimeEntryUpdate']
export type TimerAction = components['schemas']['TimerAction']
export type ProjectLifecycleOperation = components['schemas']['ProjectLifecycleOperation']
export type ApiErrorDocument = components['schemas']['ApiError']
export type Appointment = components['schemas']['Appointment']
export type AppointmentCreate = components['schemas']['AppointmentCreate']
export type AppointmentUpdate = components['schemas']['AppointmentUpdate']
export type Absence = components['schemas']['Absence']
export type AbsenceCreate = components['schemas']['AbsenceCreate']
export type AbsenceUpdate = components['schemas']['AbsenceUpdate']
export type Availability = components['schemas']['Availability']
export type ActivityEvent = components['schemas']['ActivityEvent']
export type Comment = components['schemas']['Comment']
export type CommentCreate = components['schemas']['CommentCreate']
export type Document = components['schemas']['Document']
export type DocumentCreate = components['schemas']['DocumentCreate']
export type DocumentUpdate = components['schemas']['DocumentUpdate']
export type File = components['schemas']['File']
export type FileRename = components['schemas']['FileRename']
export type FileDownloadIntent = components['schemas']['FileDownloadIntent']
export type FileUploadIntent = components['schemas']['FileUploadIntent']
export type FileUploadCancellation = components['schemas']['FileUploadCancellation']
export type FileUploadIntentCreate = components['schemas']['FileUploadIntentCreate']

export type AdministrationRevision = `adm1-${string}`

export type MemberPii = {
  contactId: string | null
  displayName: string | null
  email: string | null
  firstname: string | null
  lastname: string | null
  position: string | null
}

export type Member = {
  attributes: {
    currentGroupId: string | null
    disabled: boolean
    groupIds: string[]
    owner: boolean
    revision: AdministrationRevision
    roleId: string
    status: 'active' | 'pending'
  } & Partial<MemberPii>
  id: string
  type: 'member'
}

export type Invitation = {
  attributes: {
    createdAt: string | null
    email?: string | null
    revision: AdministrationRevision
    roleId: string
    status: 'pending'
    workspaceOwner: boolean
  }
  id: string
  type: 'invitation'
}

export type Role = {
  attributes: {
    default: boolean
    description: string
    memberCount: number
    name: string
    permissions: string[]
    revision: AdministrationRevision
    system: boolean
  }
  id: string
  type: 'role'
}

export type Group = {
  attributes: {
    createdAt: string | null
    memberIds: string[]
    name: string
    revision: AdministrationRevision
    visibility: 'all' | 'members' | 'private'
  }
  id: string
  type: 'group'
}

export type MemberRoleUpdate = { roleId: string }

export type InvitationCreate = {
  email: string
  firstname: string
  lastname: string
  position?: string
  roleId?: string
}

export type RoleCreate = {
  description?: string
  name: string
  permissions?: readonly string[]
}

export type RoleUpdate = {
  description?: string
  name?: string
  permissions?: readonly string[]
}

export type GroupCreate = {
  memberIds?: readonly string[]
  name: string
  visibility?: 'all' | 'members' | 'private'
}

export type GroupUpdate = {
  memberIds?: readonly string[]
  name?: string
  visibility?: 'all' | 'members' | 'private'
}

export type SearchResourceType = 'contacts' | 'projects' | 'tasks'

export type SearchQuery = {
  limit?: number
  term: string
  types: readonly SearchResourceType[]
}

type SearchResultBase<TType extends string> = {
  attributes: {
    archived: boolean
    title: string
    updatedAt?: string
  }
  id: string
  type: TType
}

export type ContactSearchResult = SearchResultBase<'contact'> & {
  attributes: SearchResultBase<'contact'>['attributes'] & { subtitle: string }
}

export type ProjectSearchResult = SearchResultBase<'project'> & {
  attributes: SearchResultBase<'project'>['attributes'] & {
    completed: boolean
    number: string
  }
}

export type TaskSearchResult = SearchResultBase<'task'> & {
  attributes: SearchResultBase<'task'>['attributes'] & { completed: boolean }
}

export type SearchResult = ContactSearchResult | ProjectSearchResult | TaskSearchResult

export type ExportResourceType = 'contacts' | 'projects' | 'tasks' | 'timeEntries'
export type ContactExportField =
  | 'archived'
  | 'companyTitle'
  | 'firstName'
  | 'id'
  | 'lastName'
  | 'type'
  | 'updatedAt'
export type ProjectExportField =
  | 'archived'
  | 'completed'
  | 'dueDate'
  | 'id'
  | 'managerId'
  | 'name'
  | 'number'
  | 'updatedAt'
export type TaskExportField =
  | 'archived'
  | 'assigneeIds'
  | 'completed'
  | 'contactId'
  | 'dueDate'
  | 'id'
  | 'name'
  | 'projectId'
  | 'updatedAt'
export type TimeEntryExportField =
  | 'archived'
  | 'durationMinutes'
  | 'end'
  | 'id'
  | 'locked'
  | 'start'
  | 'taskId'
  | 'updatedAt'
  | 'userId'
export type ExportField =
  | ContactExportField
  | ProjectExportField
  | TaskExportField
  | TimeEntryExportField

type ExportCreateBase = {
  fileName?: string
  format?: 'csv'
  includeArchived?: boolean
  maxRows?: number
  updatedFrom?: string | Date
  updatedUntil?: string | Date
}

export type ExportCreate = ExportCreateBase &
  (
    | { fields?: readonly ContactExportField[]; resourceType: 'contacts' }
    | { fields?: readonly ProjectExportField[]; resourceType: 'projects' }
    | { fields?: readonly TaskExportField[]; resourceType: 'tasks' }
    | { fields?: readonly TimeEntryExportField[]; resourceType: 'timeEntries' }
  )

export type ExportCreation = {
  attributes: { replayed: boolean }
  id: string
  type: 'export'
}

export type ExportJob = {
  attributes: {
    createdAt: string
    failure?: { code: 'developer-export-failed'; retryable: false }
    fields: ExportField[]
    fileName: string
    finishedAt?: string
    format: 'csv'
    resourceType: ExportResourceType
    rowCount?: number
    startedAt?: string
    state: 'failed' | 'queued' | 'retrying' | 'running' | 'succeeded'
    truncated?: boolean
  }
  id: string
  type: 'export'
}

export type ExportDownloadIntent = {
  attributes: {
    expiresAt: string
    fileName: string
    token: string
  }
  id: string
  type: 'exportDownloadIntent'
}

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type AutomationActionId =
  | 'automationTask'
  | 'condition'
  | 'createDate'
  | 'forEach'
  | 'formatDate'
  | 'listCreate'
  | 'listEdit'
  | 'loop'
  | 'loopBreak'
  | 'loopContinue'
  | 'projectCreate'
  | 'projectEdit'
  | 'projectStatementCreate'
  | 'projectStatementEdit'
  | 'serviceCreate'
  | 'serviceEdit'
  | 'setAutomationStatus'
  | 'setVariable'
  | 'stopCurrentAutomation'
  | 'taskCreate'
  | 'taskEdit'
  | 'timeentryCreate'
  | 'timeentryEdit'
  | 'waitFor'
  | 'waitForCustomFieldChange'
  | 'waitForProjectChange'
  | 'waitForTaskChange'
  | 'waitForTaskCompletion'
  | 'waitUntil'

export type AutomationTranslatable = string | null | { fallback?: string; key?: string }

export type AutomationParameterDefinition = {
  allowedValues?: JsonValue
  defaultValue?: string
  description?: AutomationTranslatable
  displayName?: AutomationTranslatable
  field?: string
  key: string
  max?: number
  min?: number
  schema?: JsonValue
  type?: string
}

export type AutomationAction = {
  attributes: {
    branches: Array<{ displayName?: AutomationTranslatable; key: string }>
    config: AutomationParameterDefinition[]
    description: AutomationTranslatable
    input: AutomationParameterDefinition[]
    name: AutomationTranslatable
    output: AutomationParameterDefinition[]
    requiredScopes: string[]
  }
  id: AutomationActionId
  type: 'automationAction'
}

export type AutomationInputParameter = { key: string; value: string }

export type AutomationInputStep = {
  actionId: AutomationActionId
  branches?: Array<{ flow: AutomationInputStep[]; key: string }>
  config?: AutomationInputParameter[]
  input?: AutomationInputParameter[]
  output?: AutomationInputParameter[]
}

export type AutomationStoredParameter =
  | { key: string; redacted: true }
  | { key: string; value?: string }

export type AutomationStoredStep =
  | { actionId: string; restricted: true }
  | {
      actionId: AutomationActionId
      branches?: Array<{ flow: AutomationStoredStep[]; key: string }>
      config?: AutomationStoredParameter[]
      input?: AutomationStoredParameter[]
      output?: AutomationStoredParameter[]
    }

export type AutomationTrigger = {
  data: { type: 'projects' | 'tasks' }
  event: 'change' | 'create'
}

export type AutomationStoredTrigger = AutomationTrigger | { restricted: true }
export type AutomationDefinitionRevision = `aut1-${string}`
export type AutomationRunRevision = `aur1-${string}`

export type AutomationDefinitionCreate = {
  description?: string
  flow: AutomationInputStep[]
  name: string
  trigger: AutomationTrigger
}

export type AutomationDefinitionUpdate = {
  description?: string
  flow?: AutomationInputStep[]
  name?: string
  trigger?: AutomationTrigger
}

export type AutomationDefinition = {
  attributes: {
    archived: boolean
    createdAt?: string
    description: string
    editable: boolean
    flow: AutomationStoredStep[]
    name: string
    replayed?: boolean
    revision: AutomationDefinitionRevision
    trigger: AutomationStoredTrigger
    updatedAt?: string
  }
  id: string
  type: 'automationDefinition'
}

export type AutomationDefinitionVersion = {
  attributes: Omit<AutomationDefinition['attributes'], 'replayed'> & {
    definitionId: string
    versionedAt: string
  }
  id: `dav1-${string}`
  type: 'automationDefinitionVersion'
}

export type AutomationTargetType = 'contact' | 'project' | 'task' | 'user' | 'workspace'
export type AutomationRunState = 'aborted' | 'failed' | 'running' | 'succeeded'

export type AutomationRun = {
  attributes: {
    abortedAt?: string
    createdAt?: string
    definition: { id: string; name: string }
    failedAt?: string
    finishedAt?: string
    reference?: { id: string; type: AutomationTargetType }
    replayed?: boolean
    revision: AutomationRunRevision
    state: AutomationRunState
    updatedAt?: string
  }
  id: string
  type: 'automationRun'
}

export type IntegrationInstallation = {
  attributes: {
    createdAt?: string
    provider: 'googleCalendar' | 'sipgate' | 'slack'
    state: 'configured'
    target: { id: string; type: AutomationTargetType }
    updatedAt?: string
    verification: 'not_checked'
  }
  id: string
  type: 'integrationInstallation'
}

export type RequestMeta = {
  requestId: string
}

export type RateLimitMetadata = {
  limit?: number
  remaining?: number
  reset?: number
}

export type TransportMetadata = {
  attempts: number
  headers: Readonly<Record<string, string>>
  idempotencyReplayed?: boolean
  rateLimit: Readonly<RateLimitMetadata>
  requestId: string
  retryAfterMs?: number
  status: number
}

export type TransportAware = {
  readonly transport: Readonly<TransportMetadata>
}

export type PageMeta = RequestMeta & {
  page: {
    limit: number
    nextCursor: string | null
  }
}

export type ResourceEnvelope<T> = TransportAware & {
  data: T
  meta: RequestMeta
}

export type ListEnvelope<T> = TransportAware & {
  data: T[]
  meta: PageMeta
}

export type ChangePageEnvelope = TransportAware & {
  data: ChangeEvent[]
  meta: RequestMeta & {
    page: {
      caughtUp: boolean
      limit: number
      nextCursor: ChangeCheckpoint
    }
  }
}

export type ListOptions = {
  cursor?: string
  limit?: number
  requestId?: string
  signal?: AbortSignal
}

export type ArchiveFilter = {
  archived?: boolean
}

export type ProjectListOptions = ListOptions &
  ArchiveFilter & {
    completed?: boolean
  }

export type ProductListOptions = ListOptions &
  ArchiveFilter & {
    disabled?: boolean
    productGroupId?: string
  }

export type ProductGroupListOptions = ListOptions &
  ArchiveFilter & {
    parentId?: string
  }

export type ProjectStatementListOptions = ListOptions &
  ArchiveFilter & {
    createdAtFrom?: string | Date
    createdAtTo?: string | Date
    createdBy?: string
    dateFrom?: string | Date
    dateTo?: string | Date
    productId?: string
    projectId?: string
    type?: 'budget' | 'bundle' | 'manual' | 'product'
  }

export type TaskListOptions = ListOptions &
  ArchiveFilter & {
    assigneeId?: string
    completed?: boolean
    projectId?: string
  }

export type TimeEntryListOptions = ListOptions &
  ArchiveFilter & {
    from?: string | Date
    taskId?: string
    to?: string | Date
    userId?: string
  }

export type ContactListOptions = ListOptions &
  ArchiveFilter & {
    type?: 'person' | 'company'
  }

export type CallNoteListOptions = ListOptions & ArchiveFilter

export type ContactGroupListOptions = ListOptions & ArchiveFilter

export type CustomFieldDefinitionListOptions = ListOptions &
  ArchiveFilter & {
    defaultEnabled?: boolean
    fieldType?:
      | 'contact'
      | 'date'
      | 'dropdown'
      | 'number'
      | 'project'
      | 'switcher'
      | 'tag'
      | 'text'
      | 'textarea'
      | 'user'
    targetType?: 'contact' | 'project' | 'projectJournalEntry' | 'task'
  }

export type ProjectTemplateListOptions = ListOptions &
  ArchiveFilter & {
    createdAtFrom?: string | Date
    createdAtTo?: string | Date
    originProjectId?: string
  }

export type PlannedWorkListOptions = ListOptions & {
  end: string | Date
  projectId?: string
  start: string | Date
  taskId?: string
  userId?: string
}

export type AuditEventListOptions = ListOptions & {
  credentialId?: string
  eventType?: string
  outcome?: 'success' | 'denied' | 'failure'
}

export type CalendarListOptions = ListOptions &
  ArchiveFilter & {
    end: string | Date
    start: string | Date
    userId?: readonly string[]
  }

export type AvailabilityListOptions = RequestOptions & {
  end: string | Date
  start: string | Date
  timeZone: string
  userId?: readonly string[]
}

export type CollaborationTarget = {
  targetId: string
  targetType: 'contact' | 'project' | 'task'
}

export type ActivityListOptions = ListOptions & CollaborationTarget
export type CommentListOptions = ListOptions & ArchiveFilter & CollaborationTarget
export type DocumentListOptions = ListOptions & ArchiveFilter
export type FileEntityType =
  | 'comment'
  | 'contact'
  | 'customField'
  | 'outcome'
  | 'project'
  | 'streamItem'
  | 'task'
  | 'team'
export type FileListOptions = ListOptions &
  ArchiveFilter & {
    entityId?: string
    entityType?: FileEntityType
  }
export type FileGetOptions = RequestOptions & ArchiveFilter

export type AppointmentRevision = `ap1-${string}`
export type AbsenceRevision = `ab1-${string}`
export type CommentRevision = `cmt1-${string}`
export type DocumentRevision = `doc1-${string}`
export type FileRevision = `file-${number}`

export type AppointmentMutationOptions = RequestOptions & {
  ifMatch: AppointmentRevision | `"${AppointmentRevision}"`
}
export type AbsenceMutationOptions = RequestOptions & {
  ifMatch: AbsenceRevision | `"${AbsenceRevision}"`
}
export type CommentMutationOptions = RequestOptions & {
  ifMatch: CommentRevision | `"${CommentRevision}"`
}
export type DocumentMutationOptions = RequestOptions & {
  ifMatch: `"${DocumentRevision}"`
}
export type FileMutationOptions = RequestOptions & {
  ifMatch: `"${FileRevision}"`
}

export type MemberListOptions = ListOptions & { includePii?: boolean }
export type InvitationListOptions = ListOptions & { includePii?: boolean }
export type AdministrationPiiOptions = RequestOptions & { includePii?: boolean }

export type AdministrationMutationOptions = RequestOptions & {
  ifMatch: AdministrationRevision | `"${AdministrationRevision}"`
}

export type InvitationResendOptions = MutationOptions & {
  ifMatch: AdministrationRevision | `"${AdministrationRevision}"`
}

export type ExportDownloadOptions = RequestOptions & {
  intentToken: string
  /** A caller-selected ceiling. The SDK never permits more than 50 MiB. */
  maxBytes?: number
}

export type ExportDownload = TransportAware & {
  contentType: 'text/csv; charset=utf-8'
  data: Uint8Array
  fileName: string
}

export type AutomationDefinitionListOptions = ListOptions & { archived?: boolean }

export type AutomationDefinitionMutationOptions = RequestOptions & {
  ifMatch: AutomationDefinitionRevision | `"${AutomationDefinitionRevision}"`
}

export type AutomationRunListOptions = ListOptions & {
  definitionId?: string
  referenceId?: string
  referenceType?: AutomationTargetType
  state?: AutomationRunState
}

export type AutomationRunMutationOptions = RequestOptions & {
  ifMatch: AutomationRunRevision | `"${AutomationRunRevision}"`
}

export type ChangeFilterOptions = RequestOptions & {
  limit?: number
  operations?: readonly ChangeOperation[]
  resourceTypes?: readonly ChangeResourceType[]
}

export type ChangeListOptions = ChangeFilterOptions & {
  cursor?: ChangeCheckpoint
  startAtLatest?: boolean
}

export type ChangeCatchUpOptions = ChangeFilterOptions & {
  cursor?: ChangeCheckpoint
}

export type ChangeFeedBootstrap<T> = {
  /** The checkpoint taken immediately before the snapshot started. */
  checkpoint: ChangeCheckpoint
  /** A bounded catch-up traversal after the snapshot checkpoint. */
  pages: AsyncIterable<ChangePageEnvelope>
  snapshot: T
}

export type LookupListOptions = ListOptions & ArchiveFilter

export type ListLookupListOptions = LookupListOptions & {
  parentId?: string
  type?: 'tasks' | 'projects' | 'personal'
}

export type WebhookListOptions = ListOptions

export type WebhookDeliveryListOptions = ListOptions & {
  event?: string
  state?: 'delivering' | 'failed' | 'retrying' | 'skipped' | 'succeeded'
  webhookId?: string
}

export type MutationOptions = {
  idempotencyKey?: string
  requestId?: string
  signal?: AbortSignal
}

/**
 * A compare-and-set precondition obtained from the latest custom-field-value
 * response. Both the resource revision and its quoted strong ETag are accepted.
 */
export type CustomFieldValueMutationOptions = RequestOptions & {
  ifMatch: CustomFieldValueRevision | `"${string}"`
}

export type ProjectTemplateInstantiationWaitOptions = RequestOptions & {
  maxWaitMs?: number
  pollIntervalMs?: number
}

export type PlannedWorkReplaceOptions = MutationOptions & {
  ifMatch: PlannedWorkRevision | `"${string}"`
}

export type PlannedWorkOperationWaitOptions = RequestOptions & {
  maxWaitMs?: number
  pollIntervalMs?: number
}

export type ProjectLifecycleWaitOptions = RequestOptions & {
  maxWaitMs?: number
  pollIntervalMs?: number
}

export type RequestOptions = {
  requestId?: string
  signal?: AbortSignal
}

export type PaginationOptions = {
  maxPages?: number
  signal?: AbortSignal
}

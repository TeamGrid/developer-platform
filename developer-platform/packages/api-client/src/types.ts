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

export type AuditEventListOptions = ListOptions & {
  credentialId?: string
  eventType?: string
  outcome?: 'success' | 'denied' | 'failure'
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

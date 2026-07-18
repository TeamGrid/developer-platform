import type { components } from './generated/schema.js'

export type Workspace = components['schemas']['Workspace']
export type Project = components['schemas']['Project']
export type Task = components['schemas']['Task']
export type TimeEntry = components['schemas']['TimeEntry']
export type Contact = components['schemas']['Contact']
export type User = components['schemas']['User']
export type Lookup = components['schemas']['Lookup']
export type AuditEvent = components['schemas']['AuditEvent']
export type Webhook = components['schemas']['Webhook']
export type WebhookCreate = components['schemas']['WebhookCreate']
export type TaskCreate = components['schemas']['TaskCreate']
export type TaskUpdate = components['schemas']['TaskUpdate']
export type TimeEntryCreate = components['schemas']['TimeEntryCreate']
export type TimeEntryUpdate = components['schemas']['TimeEntryUpdate']
export type ApiErrorDocument = components['schemas']['ApiError']

export type RequestMeta = {
  requestId: string
}

export type PageMeta = RequestMeta & {
  page: {
    limit: number
    nextCursor: string | null
  }
}

export type ResourceEnvelope<T> = {
  data: T
  meta: RequestMeta
}

export type ListEnvelope<T> = {
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

export type AuditEventListOptions = ListOptions & {
  credentialId?: string
  eventType?: string
  outcome?: 'success' | 'denied' | 'failure'
}

export type LookupListOptions = ListOptions & ArchiveFilter

export type ListLookupListOptions = LookupListOptions & {
  type?: string
}

export type WebhookListOptions = ListOptions

export type MutationOptions = {
  idempotencyKey?: string
  requestId?: string
  signal?: AbortSignal
}

export type RequestOptions = {
  requestId?: string
  signal?: AbortSignal
}

export type PaginationOptions = {
  maxPages?: number
  signal?: AbortSignal
}

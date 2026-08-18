import { TeamGridClientError } from './errors.js'
import type {
  Absence,
  ActivityEvent,
  Appointment,
  AutomationAction,
  AutomationActionId,
  AutomationDefinition,
  AutomationDefinitionVersion,
  AutomationRun,
  Availability,
  Comment,
  Document,
  EventDefinition,
  ExportCreation,
  ExportDownloadIntent,
  ExportJob,
  File,
  FileDownloadIntent,
  FileUploadCancellation,
  FileUploadIntent,
  Group,
  IntegrationInstallation,
  Invitation,
  ListEnvelope,
  Member,
  ResourceEnvelope,
  Role,
  SearchResult,
  SystemCapability,
  TaskRecurrence,
  TaskRecurrenceEvent,
  TaskRecurrenceOccurrence,
  TaskRecurrenceOperation,
  TaskRecurrencePreview,
  TaskRecurrenceVersion,
  TimeEntryBilling,
  TransportMetadata,
  Webhook,
  WebhookCreate,
  WebhookSecretRotation,
  WebhookTestDelivery,
  WebhookUpdate,
  WorkspaceEntitlement,
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
} from './types.js'

type ResourceValidator<T> = (value: unknown) => value is T
type RecordValue = Record<string, unknown>

const administrationIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const exportIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/
const administrationRevisionPattern = /^adm1-[a-f0-9]{64}$/
const automationDefinitionRevisionPattern = /^aut1-[a-f0-9]{64}$/
const automationRunRevisionPattern = /^aur1-[a-f0-9]{64}$/
const automationDefinitionVersionPattern = /^dav1-[a-f0-9]{64}$/
const workspaceSettingsRevisionPattern = /^wst1-[a-f0-9]{64}$/
const webhookRevisionPattern = /^whk1-[a-f0-9]{64}$/
const timeEntryBillingRevisionPattern = /^tib1-[a-f0-9]{64}$/
const taskRecurrenceRevisionPattern = /^[a-f0-9]{64}$/
const taskRecurrenceIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/
const taskRecurrenceOccurrenceKeyPattern = /^(?:occ1-[a-f0-9]{64}|seed:[A-Za-z0-9_-]{1,128})$/
const taskRecurrencePlaceholderTokenPattern = /^trp1\.[A-Za-z0-9_-]+$/
const webhookSigningSecretPattern = /^whsec_v2_[A-Za-z0-9_-]{43}$/
const publicCapabilityIdPattern = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
const webhookIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const eventDefinitionIdPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/
const scopePattern = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){1,2}$/
const downloadIntentPattern = /^ex1\.\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/
const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const sensitiveKeyPattern = /authorization|cookie|credential|password|secret|token/i

const actionIds = new Set<AutomationActionId>([
  'automationTask',
  'condition',
  'createDate',
  'forEach',
  'formatDate',
  'listCreate',
  'listEdit',
  'loop',
  'loopBreak',
  'loopContinue',
  'projectCreate',
  'projectEdit',
  'projectStatementCreate',
  'projectStatementEdit',
  'serviceCreate',
  'serviceEdit',
  'setAutomationStatus',
  'setVariable',
  'stopCurrentAutomation',
  'taskCreate',
  'taskEdit',
  'timeentryCreate',
  'timeentryEdit',
  'waitFor',
  'waitForCustomFieldChange',
  'waitForProjectChange',
  'waitForTaskChange',
  'waitForTaskCompletion',
  'waitUntil',
])

const exportFields: Record<string, ReadonlySet<string>> = {
  auditEvents: new Set([
    'actorId',
    'actorType',
    'cellId',
    'createdAt',
    'credentialId',
    'eventType',
    'id',
    'metadata',
    'outcome',
    'region',
    'requestId',
    'source',
    'targetId',
    'targetType',
  ]),
  contacts: new Set([
    'archived',
    'companyTitle',
    'firstName',
    'id',
    'lastName',
    'type',
    'updatedAt',
  ]),
  projects: new Set([
    'archived',
    'completed',
    'dueDate',
    'id',
    'managerId',
    'name',
    'number',
    'updatedAt',
  ]),
  tasks: new Set([
    'archived',
    'assigneeIds',
    'completed',
    'contactId',
    'dueDate',
    'id',
    'name',
    'projectId',
    'updatedAt',
  ]),
  taskRecurrences: new Set([
    'archivedAt',
    'createdAt',
    'createdBy',
    'currentDefinitionVersionId',
    'definitionHash',
    'definitionVersion',
    'id',
    'name',
    'ownerId',
    'ownerKind',
    'policy',
    'projectId',
    'status',
    'summary',
    'template',
    'updatedAt',
  ]),
  timeEntries: new Set([
    'archived',
    'durationMinutes',
    'end',
    'id',
    'locked',
    'start',
    'taskId',
    'updatedAt',
    'userId',
  ]),
}

function invalid(label: string): never {
  throw new TeamGridClientError(
    'invalid_api_response',
    `The TeamGrid API returned an invalid ${label} response.`,
  )
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is RecordValue {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function hasAllowedKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is RecordValue {
  if (!isRecord(value)) return false
  const allowedSet = new Set(allowed)
  return (
    Object.keys(value).every((key) => allowedSet.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  )
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !canonicalDatePattern.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function nullableCanonicalDate(value: unknown): value is string | null {
  return value === null || canonicalDate(value)
}

function nullableId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && administrationIdPattern.test(value))
}

function sortedUniqueStrings(
  value: unknown,
  maximum: number,
  predicate: (item: string) => boolean,
): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !predicate(item))
  ) {
    return false
  }
  return (
    new Set(value).size === value.length &&
    value.every((item, index) => index === 0 || String(value[index - 1]) < item)
  )
}

function uniqueStrings(
  value: unknown,
  maximum: number,
  predicate: (item: string) => boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && predicate(item)) &&
    new Set(value).size === value.length
  )
}

function exactResource(
  value: unknown,
  type: string,
  idPattern: RegExp,
  attributes: (value: unknown) => boolean,
): value is { attributes: RecordValue; id: string; type: string } {
  return (
    hasExactKeys(value, ['attributes', 'id', 'type']) &&
    value.type === type &&
    typeof value.id === 'string' &&
    idPattern.test(value.id) &&
    attributes(value.attributes)
  )
}

function requestMeta(value: unknown) {
  return hasExactKeys(value, ['requestId']) && boundedString(value.requestId, 256, false)
}

function resourceIdentity(resource: unknown) {
  return isRecord(resource) && typeof resource.id === 'string' ? resource.id : ''
}

export function assertStrictResource<T>(
  value: unknown,
  validator: ResourceValidator<T>,
  label: string,
): ResourceEnvelope<T> {
  if (
    !hasExactKeys(value, ['data', 'meta']) ||
    !requestMeta(value.meta) ||
    !validator(value.data)
  ) {
    invalid(label)
  }
  return value as ResourceEnvelope<T>
}

export function assertStrictResourceArray<T>(
  value: unknown,
  validator: ResourceValidator<T>,
  label: string,
  maximum: number,
  identityKey: (resource: T) => string = resourceIdentity,
): ResourceEnvelope<T[]> {
  if (
    !hasExactKeys(value, ['data', 'meta']) ||
    !requestMeta(value.meta) ||
    !Array.isArray(value.data) ||
    value.data.length > maximum ||
    value.data.some((item) => !validator(item)) ||
    new Set(value.data.map((item) => identityKey(item))).size !== value.data.length
  ) {
    invalid(label)
  }
  return value as ResourceEnvelope<T[]>
}

export function assertStrictOrderedResourceArray<T>(
  value: unknown,
  validator: ResourceValidator<T>,
  label: string,
  maximum: number,
  orderKey: (resource: T) => string,
): ResourceEnvelope<T[]> {
  const envelope = assertStrictResourceArray(value, validator, label, maximum, orderKey)
  if (
    envelope.data.some((resource, index) => {
      const previous = envelope.data[index - 1]
      return previous !== undefined && orderKey(previous) >= orderKey(resource)
    })
  ) {
    invalid(label)
  }
  return envelope
}

export function assertStrictPage<T>(
  value: unknown,
  validator: ResourceValidator<T>,
  label: string,
  maximumLimit = 200,
): ListEnvelope<T> {
  if (
    !hasExactKeys(value, ['data', 'meta']) ||
    !hasExactKeys(value.meta, ['page', 'requestId']) ||
    !boundedString(value.meta.requestId, 256, false) ||
    !hasExactKeys(value.meta.page, ['limit', 'nextCursor']) ||
    !Number.isSafeInteger(value.meta.page.limit) ||
    Number(value.meta.page.limit) < 1 ||
    Number(value.meta.page.limit) > maximumLimit ||
    !(value.meta.page.nextCursor === null || typeof value.meta.page.nextCursor === 'string') ||
    !Array.isArray(value.data) ||
    value.data.length > Number(value.meta.page.limit) ||
    value.data.some((item) => !validator(item)) ||
    new Set(value.data.map((item) => (item as { id: string }).id)).size !== value.data.length
  ) {
    invalid(label)
  }
  return value as ListEnvelope<T>
}

function memberPii(value: RecordValue) {
  const nullableText = (candidate: unknown, maximum: number) =>
    candidate === null ||
    (boundedString(candidate, maximum, false) && candidate === candidate.trim())
  return (
    nullableId(value.contactId) &&
    nullableText(value.displayName, 1000) &&
    nullableText(value.firstname, 500) &&
    nullableText(value.lastname, 500) &&
    nullableText(value.position, 1000) &&
    (value.email === null ||
      (boundedString(value.email, 254, false) &&
        value.email === value.email.trim().toLowerCase() &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)))
  )
}

function memberAttributes(value: unknown, includePii: boolean) {
  const base = ['currentGroupId', 'disabled', 'groupIds', 'owner', 'revision', 'roleId', 'status']
  const pii = ['contactId', 'displayName', 'email', 'firstname', 'lastname', 'position']
  if (!hasExactKeys(value, includePii ? [...base, ...pii] : base)) return false
  return (
    nullableId(value.currentGroupId) &&
    typeof value.disabled === 'boolean' &&
    sortedUniqueStrings(value.groupIds, 1000, (item) => administrationIdPattern.test(item)) &&
    typeof value.owner === 'boolean' &&
    typeof value.revision === 'string' &&
    administrationRevisionPattern.test(value.revision) &&
    typeof value.roleId === 'string' &&
    administrationIdPattern.test(value.roleId) &&
    (value.status === 'active' || value.status === 'pending') &&
    (!includePii || memberPii(value))
  )
}

export function memberValidator(includePii: boolean): ResourceValidator<Member> {
  return (value): value is Member =>
    exactResource(value, 'member', administrationIdPattern, (attributes) =>
      memberAttributes(attributes, includePii),
    )
}

function invitationAttributes(value: unknown, includePii: boolean) {
  const base = ['createdAt', 'revision', 'roleId', 'status', 'workspaceOwner']
  if (!hasExactKeys(value, includePii ? [...base, 'email'] : base)) return false
  return (
    nullableCanonicalDate(value.createdAt) &&
    typeof value.revision === 'string' &&
    administrationRevisionPattern.test(value.revision) &&
    typeof value.roleId === 'string' &&
    administrationIdPattern.test(value.roleId) &&
    value.status === 'pending' &&
    typeof value.workspaceOwner === 'boolean' &&
    (!includePii ||
      value.email === null ||
      (boundedString(value.email, 254, false) &&
        value.email === value.email.trim().toLowerCase() &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)))
  )
}

export function invitationValidator(includePii: boolean): ResourceValidator<Invitation> {
  return (value): value is Invitation =>
    exactResource(value, 'invitation', administrationIdPattern, (attributes) =>
      invitationAttributes(attributes, includePii),
    )
}

export const invitationCreateValidator: ResourceValidator<Invitation> = (
  value,
): value is Invitation => invitationValidator(false)(value) || invitationValidator(true)(value)

export const roleValidator: ResourceValidator<Role> = (value): value is Role => {
  if (!isRecord(value) || typeof value.id !== 'string') return false
  const roleId = value.id
  return exactResource(value, 'role', administrationIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'default',
        'description',
        'memberCount',
        'name',
        'permissions',
        'revision',
        'system',
      ]) ||
      typeof attributes.default !== 'boolean' ||
      !boundedString(attributes.description, 1000) ||
      !Number.isSafeInteger(attributes.memberCount) ||
      Number(attributes.memberCount) < 0 ||
      !boundedString(attributes.name, 100) ||
      !sortedUniqueStrings(
        attributes.permissions,
        500,
        (item) => item.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(item),
      ) ||
      typeof attributes.revision !== 'string' ||
      !administrationRevisionPattern.test(attributes.revision) ||
      typeof attributes.system !== 'boolean'
    ) {
      return false
    }
    return roleId === 'default' ? attributes.system : !attributes.system
  })
}

export const groupValidator: ResourceValidator<Group> = (value): value is Group =>
  exactResource(
    value,
    'group',
    administrationIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['createdAt', 'memberIds', 'name', 'revision', 'visibility']) &&
      nullableCanonicalDate(attributes.createdAt) &&
      sortedUniqueStrings(attributes.memberIds, 1000, (item) =>
        administrationIdPattern.test(item),
      ) &&
      boundedString(attributes.name, 100) &&
      typeof attributes.revision === 'string' &&
      administrationRevisionPattern.test(attributes.revision) &&
      ['all', 'members', 'private'].includes(String(attributes.visibility)),
  )

function calendarBoundary(value: unknown) {
  return (
    hasExactKeys(value, ['at', 'timeZone']) &&
    canonicalDate(value.at) &&
    (value.timeZone === null || boundedString(value.timeZone, 128))
  )
}

export const appointmentValidator: ResourceValidator<Appointment> = (value): value is Appointment =>
  exactResource(value, 'appointment', exportIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'allDay',
        'archived',
        'busy',
        'createdAt',
        'description',
        'end',
        'location',
        'managedBy',
        'redacted',
        'revision',
        'start',
        'title',
        'updatedAt',
        'userId',
        'visibility',
      ]) ||
      typeof attributes.allDay !== 'boolean' ||
      typeof attributes.archived !== 'boolean' ||
      typeof attributes.busy !== 'boolean' ||
      !nullableCanonicalDate(attributes.createdAt) ||
      !calendarBoundary(attributes.end) ||
      !calendarBoundary(attributes.start) ||
      !['provider', 'teamgrid'].includes(String(attributes.managedBy)) ||
      typeof attributes.redacted !== 'boolean' ||
      typeof attributes.revision !== 'string' ||
      !/^ap1-[a-f0-9]{64}$/.test(attributes.revision) ||
      !nullableCanonicalDate(attributes.updatedAt) ||
      typeof attributes.userId !== 'string' ||
      !administrationIdPattern.test(attributes.userId) ||
      !['default', 'private', 'public'].includes(String(attributes.visibility)) ||
      ![attributes.description, attributes.location, attributes.title].every(
        (item) => item === null || typeof item === 'string',
      )
    ) {
      return false
    }
    return (
      !attributes.redacted ||
      [attributes.description, attributes.location, attributes.title].every((item) => item === null)
    )
  })

export const absenceValidator: ResourceValidator<Absence> = (value): value is Absence =>
  exactResource(value, 'absence', exportIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'archived',
        'archivedAt',
        'createdAt',
        'end',
        'reason',
        'revision',
        'start',
        'userId',
      ]) ||
      typeof attributes.archived !== 'boolean' ||
      !nullableCanonicalDate(attributes.archivedAt) ||
      !nullableCanonicalDate(attributes.createdAt) ||
      !canonicalDate(attributes.end) ||
      !(attributes.reason === null || typeof attributes.reason === 'string') ||
      typeof attributes.revision !== 'string' ||
      !/^ab1-[a-f0-9]{64}$/.test(attributes.revision) ||
      !canonicalDate(attributes.start) ||
      typeof attributes.userId !== 'string' ||
      !administrationIdPattern.test(attributes.userId)
    ) {
      return false
    }
    return attributes.archived ? attributes.archivedAt !== null : attributes.archivedAt === null
  })

export const availabilityValidator: ResourceValidator<Availability> = (
  value,
): value is Availability =>
  exactResource(value, 'availability', /^current$/, (attributes) => {
    if (
      !hasExactKeys(attributes, ['end', 'start', 'timeZone', 'users']) ||
      !canonicalDate(attributes.end) ||
      !canonicalDate(attributes.start) ||
      attributes.start >= attributes.end ||
      !boundedString(attributes.timeZone, 128, false) ||
      !Array.isArray(attributes.users) ||
      attributes.users.length > 50
    ) {
      return false
    }
    const windowStart = attributes.start
    const windowEnd = attributes.end
    return attributes.users.every(
      (user) =>
        hasExactKeys(user, ['intervals', 'userId']) &&
        typeof user.userId === 'string' &&
        administrationIdPattern.test(user.userId) &&
        Array.isArray(user.intervals) &&
        user.intervals.every(
          (interval) =>
            hasExactKeys(interval, ['end', 'start']) &&
            canonicalDate(interval.end) &&
            canonicalDate(interval.start) &&
            interval.start < interval.end &&
            interval.start >= windowStart &&
            interval.end <= windowEnd,
        ),
    )
  })

function collaborationTarget(value: unknown) {
  return (
    hasExactKeys(value, ['id', 'type']) &&
    typeof value.id === 'string' &&
    exportIdPattern.test(value.id) &&
    ['contact', 'project', 'task'].includes(String(value.type))
  )
}

export const activityEventValidator: ResourceValidator<ActivityEvent> = (
  value,
): value is ActivityEvent =>
  exactResource(
    value,
    'activityEvent',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['actorId', 'eventType', 'occurredAt', 'target']) &&
      (attributes.actorId === null ||
        (typeof attributes.actorId === 'string' &&
          administrationIdPattern.test(attributes.actorId))) &&
      boundedString(attributes.eventType, 128, false) &&
      /^[A-Za-z0-9_.:-]+$/.test(attributes.eventType) &&
      canonicalDate(attributes.occurredAt) &&
      collaborationTarget(attributes.target),
  )

export const commentValidator: ResourceValidator<Comment> = (value): value is Comment =>
  exactResource(
    value,
    'comment',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'archived',
        'authorId',
        'createdAt',
        'revision',
        'target',
        'text',
        'updatedAt',
      ]) &&
      typeof attributes.archived === 'boolean' &&
      (attributes.authorId === null ||
        (typeof attributes.authorId === 'string' &&
          administrationIdPattern.test(attributes.authorId))) &&
      canonicalDate(attributes.createdAt) &&
      typeof attributes.revision === 'string' &&
      /^cmt1-[a-f0-9]{64}$/.test(attributes.revision) &&
      collaborationTarget(attributes.target) &&
      boundedString(attributes.text, 10_000) &&
      canonicalDate(attributes.updatedAt),
  )

export function documentValidator(
  content: 'absent' | 'optional' | 'required',
): ResourceValidator<Document> {
  return (value): value is Document =>
    exactResource(value, 'document', exportIdPattern, (attributes) => {
      if (!isRecord(attributes)) return false
      const base = ['archived', 'createdAt', 'createdBy', 'name', 'updatedAt', 'updatedBy']
      const keys = content === 'required' ? [...base, 'content'] : base
      if (
        (content === 'optional'
          ? !hasAllowedKeys(attributes, [...base, 'content'], base)
          : !hasExactKeys(attributes, keys)) ||
        typeof attributes.archived !== 'boolean' ||
        !nullableCanonicalDate(attributes.createdAt) ||
        !(
          attributes.createdBy === null ||
          (typeof attributes.createdBy === 'string' &&
            administrationIdPattern.test(attributes.createdBy))
        ) ||
        !boundedString(attributes.name, 500) ||
        !nullableCanonicalDate(attributes.updatedAt) ||
        !(
          attributes.updatedBy === null ||
          (typeof attributes.updatedBy === 'string' &&
            administrationIdPattern.test(attributes.updatedBy))
        ) ||
        (attributes.content !== undefined &&
          (typeof attributes.content !== 'string' ||
            new TextEncoder().encode(attributes.content).byteLength > 1024 * 1024))
      ) {
        return false
      }
      return content !== 'required' || typeof attributes.content === 'string'
    })
}

function nullableRevision(value: unknown) {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 1)
}

export const fileValidator: ResourceValidator<File> = (value): value is File =>
  exactResource(
    value,
    'file',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'archived',
        'blocked',
        'contentRevision',
        'createdAt',
        'createdBy',
        'downloadAvailable',
        'links',
        'metadataRevision',
        'mimeType',
        'name',
        'previewStatus',
        'size',
        'space',
        'syncRevision',
        'updatedAt',
        'updatedBy',
      ]) &&
      typeof attributes.archived === 'boolean' &&
      typeof attributes.blocked === 'boolean' &&
      nullableRevision(attributes.contentRevision) &&
      nullableCanonicalDate(attributes.createdAt) &&
      (attributes.createdBy === null ||
        (typeof attributes.createdBy === 'string' &&
          administrationIdPattern.test(attributes.createdBy))) &&
      typeof attributes.downloadAvailable === 'boolean' &&
      Array.isArray(attributes.links) &&
      attributes.links.every(
        (link) =>
          hasExactKeys(link, ['entityId', 'entityType', 'linkType']) &&
          typeof link.entityId === 'string' &&
          exportIdPattern.test(link.entityId) &&
          [
            'comment',
            'contact',
            'customField',
            'outcome',
            'project',
            'streamItem',
            'task',
            'team',
          ].includes(String(link.entityType)) &&
          ['attachment', 'folder', 'generated', 'manual', 'primary', 'system'].includes(
            String(link.linkType),
          ),
      ) &&
      nullableRevision(attributes.metadataRevision) &&
      typeof attributes.mimeType === 'string' &&
      boundedString(attributes.name, 240) &&
      typeof attributes.previewStatus === 'string' &&
      Number.isSafeInteger(attributes.size) &&
      Number(attributes.size) >= 0 &&
      ['contacts', 'projects', 'tasks', 'team'].includes(String(attributes.space)) &&
      nullableRevision(attributes.syncRevision) &&
      nullableCanonicalDate(attributes.updatedAt) &&
      (attributes.updatedBy === null ||
        (typeof attributes.updatedBy === 'string' &&
          administrationIdPattern.test(attributes.updatedBy))),
  )

function transferMetadata(value: unknown) {
  return (
    hasExactKeys(value, ['fileName', 'mimeType', 'size']) &&
    boundedString(value.fileName, 240, false) &&
    typeof value.mimeType === 'string' &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0
  )
}

function transfer(value: unknown, kind: 'download' | 'upload', file: RecordValue) {
  if (
    !hasExactKeys(value, ['expiresAt', 'headers', 'id', 'maxSize', 'method', 'url']) ||
    !canonicalDate(value.expiresAt) ||
    typeof value.id !== 'string' ||
    !exportIdPattern.test(value.id) ||
    !hasAllowedKeys(value.headers, ['content-length', 'content-type', 'x-amz-acl'], []) ||
    Object.values(value.headers).some((header) => typeof header !== 'string')
  ) {
    return false
  }
  const expires = new Date(value.expiresAt).getTime()
  const lifetime = expires - Date.now()
  if (lifetime <= 0 || lifetime > 20 * 60 * 1000) return false
  let url: URL
  try {
    url = new URL(String(value.url))
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
  const length = value.headers['content-length']
  const contentType = value.headers['content-type']
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== file.size)) {
    return false
  }
  if (contentType !== undefined && contentType !== file.mimeType) return false
  if (kind === 'download') {
    return (
      value.method === 'GET' && value.maxSize === null && value.headers['x-amz-acl'] === undefined
    )
  }
  return (
    value.method === 'PUT' &&
    Number.isSafeInteger(value.maxSize) &&
    Number(value.maxSize) >= 1 &&
    Number(value.maxSize) >= Number(file.size) &&
    (value.headers['x-amz-acl'] === undefined || value.headers['x-amz-acl'] === 'private')
  )
}

function fileTransferIntentValidator(
  kind: 'download' | 'upload',
): ResourceValidator<FileDownloadIntent | FileUploadIntent> {
  const type = kind === 'download' ? 'fileDownloadIntent' : 'fileUploadIntent'
  return (value): value is FileDownloadIntent | FileUploadIntent => {
    if (!isRecord(value) || typeof value.id !== 'string') return false
    const intentId = value.id
    return exactResource(
      value,
      type,
      exportIdPattern,
      (attributes) =>
        hasExactKeys(attributes, ['file', 'transfer']) &&
        transferMetadata(attributes.file) &&
        isRecord(attributes.file) &&
        transfer(attributes.transfer, kind, attributes.file) &&
        isRecord(attributes.transfer) &&
        attributes.transfer.id === intentId,
    )
  }
}

export const fileDownloadIntentValidator = fileTransferIntentValidator(
  'download',
) as ResourceValidator<FileDownloadIntent>
export const fileUploadIntentValidator = fileTransferIntentValidator(
  'upload',
) as ResourceValidator<FileUploadIntent>

export const fileUploadCancellationValidator: ResourceValidator<FileUploadCancellation> = (
  value,
): value is FileUploadCancellation =>
  exactResource(
    value,
    'fileUploadIntent',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['replayed', 'state']) &&
      typeof attributes.replayed === 'boolean' &&
      attributes.state === 'canceled',
  )

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function documentEtag(updatedAt: string | null) {
  return updatedAt === null ? null : `"doc1-${base64Url(updatedAt)}"`
}

export function fileEtag(syncRevision: number | null) {
  return syncRevision === null ? null : `"file-${syncRevision}"`
}

export const searchResultValidator: ResourceValidator<SearchResult> = (
  value,
): value is SearchResult => {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.attributes)) {
    return false
  }
  const attributes = value.attributes
  const common = (keys: readonly string[]) =>
    exactResource(
      value,
      value.type as string,
      exportIdPattern,
      (attributes) =>
        hasExactKeys(attributes, keys) &&
        typeof attributes.archived === 'boolean' &&
        boundedString(attributes.title, 2000) &&
        (attributes.updatedAt === undefined || canonicalDate(attributes.updatedAt)),
    )
  if (value.type === 'contact') {
    return (
      common([
        'archived',
        'subtitle',
        'title',
        ...(Object.hasOwn(attributes, 'updatedAt') ? ['updatedAt'] : []),
      ]) && boundedString(attributes.subtitle, 2000)
    )
  }
  if (value.type === 'project') {
    return (
      common([
        'archived',
        'completed',
        'number',
        'title',
        ...(Object.hasOwn(attributes, 'updatedAt') ? ['updatedAt'] : []),
      ]) &&
      typeof attributes.completed === 'boolean' &&
      boundedString(attributes.number, 256)
    )
  }
  return (
    value.type === 'task' &&
    common([
      'archived',
      'completed',
      'title',
      ...(Object.hasOwn(attributes, 'updatedAt') ? ['updatedAt'] : []),
    ]) &&
    typeof attributes.completed === 'boolean'
  )
}

function safeFileName(value: unknown): value is string {
  return (
    boundedString(value, 120, false) &&
    value !== '.' &&
    value !== '..' &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127 && character !== '/' && character !== '\\'
    })
  )
}

export const exportCreationValidator: ResourceValidator<ExportCreation> = (
  value,
): value is ExportCreation =>
  exactResource(
    value,
    'export',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['replayed']) && typeof attributes.replayed === 'boolean',
  )

export const exportJobValidator: ResourceValidator<ExportJob> = (value): value is ExportJob =>
  exactResource(value, 'export', exportIdPattern, (attributes) => {
    const required = ['createdAt', 'fields', 'fileName', 'format', 'resourceType', 'state']
    const optional = ['failure', 'finishedAt', 'rowCount', 'startedAt', 'truncated']
    if (!hasAllowedKeys(attributes, [...required, ...optional], required)) return false
    const allowedFields =
      typeof attributes.resourceType === 'string'
        ? exportFields[attributes.resourceType]
        : undefined
    if (
      !allowedFields ||
      !['failed', 'queued', 'retrying', 'running', 'succeeded'].includes(
        String(attributes.state),
      ) ||
      !Array.isArray(attributes.fields) ||
      attributes.fields.length < 1 ||
      attributes.fields.length > 16 ||
      new Set(attributes.fields).size !== attributes.fields.length ||
      attributes.fields.some((field) => typeof field !== 'string' || !allowedFields.has(field)) ||
      !safeFileName(attributes.fileName) ||
      attributes.format !== 'csv' ||
      !canonicalDate(attributes.createdAt) ||
      (attributes.startedAt !== undefined && !canonicalDate(attributes.startedAt)) ||
      (attributes.finishedAt !== undefined && !canonicalDate(attributes.finishedAt)) ||
      (attributes.rowCount !== undefined &&
        (!Number.isSafeInteger(attributes.rowCount) ||
          Number(attributes.rowCount) < 0 ||
          Number(attributes.rowCount) > 10_000))
    ) {
      return false
    }
    const failed = attributes.state === 'failed'
    const succeeded = attributes.state === 'succeeded'
    return (
      (failed
        ? hasExactKeys(attributes.failure, ['code', 'retryable']) &&
          attributes.failure.code === 'developer-export-failed' &&
          attributes.failure.retryable === false
        : attributes.failure === undefined) &&
      (succeeded
        ? typeof attributes.truncated === 'boolean'
        : attributes.truncated === undefined) &&
      ((!failed && !succeeded) || attributes.finishedAt !== undefined)
    )
  })

export const exportDownloadIntentValidator: ResourceValidator<ExportDownloadIntent> = (
  value,
): value is ExportDownloadIntent =>
  exactResource(
    value,
    'exportDownloadIntent',
    exportIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['expiresAt', 'fileName', 'token']) &&
      canonicalDate(attributes.expiresAt) &&
      safeFileName(attributes.fileName) &&
      typeof attributes.token === 'string' &&
      downloadIntentPattern.test(attributes.token),
  )

function translatable(value: unknown): boolean {
  if (value === null) return true
  if (boundedString(value, 1000)) return true
  return (
    hasAllowedKeys(value, ['fallback', 'key'], []) &&
    Object.keys(value).length > 0 &&
    (value.key === undefined || boundedString(value.key, 256, false)) &&
    (value.fallback === undefined || boundedString(value.fallback, 1000))
  )
}

function publicMetadata(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 2000
  if (depth >= 4) return false
  if (Array.isArray(value)) {
    return value.length <= 50 && value.every((item) => publicMetadata(item, depth + 1))
  }
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length <= 50 &&
    keys.every((key) => !sensitiveKeyPattern.test(key) && publicMetadata(value[key], depth + 1))
  )
}

function parameterDefinition(value: unknown): boolean {
  const allowed = [
    'allowedValues',
    'defaultValue',
    'description',
    'displayName',
    'field',
    'key',
    'max',
    'min',
    'schema',
    'type',
  ]
  return (
    hasAllowedKeys(value, allowed, ['key']) &&
    typeof value.key === 'string' &&
    administrationIdPattern.test(value.key) &&
    (value.type === undefined || boundedString(value.type, 128, false)) &&
    (value.field === undefined || boundedString(value.field, 128, false)) &&
    (value.defaultValue === undefined || boundedString(value.defaultValue, 2000)) &&
    (value.min === undefined || (typeof value.min === 'number' && Number.isFinite(value.min))) &&
    (value.max === undefined || (typeof value.max === 'number' && Number.isFinite(value.max))) &&
    (value.displayName === undefined || translatable(value.displayName)) &&
    (value.description === undefined || translatable(value.description)) &&
    (value.allowedValues === undefined || publicMetadata(value.allowedValues)) &&
    (value.schema === undefined || publicMetadata(value.schema))
  )
}

export const automationActionValidator: ResourceValidator<AutomationAction> = (
  value,
): value is AutomationAction =>
  exactResource(
    value,
    'automationAction',
    administrationIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'branches',
        'config',
        'description',
        'input',
        'name',
        'output',
        'requiredScopes',
      ]) &&
      isRecord(value) &&
      actionIds.has(value.id as AutomationActionId) &&
      Array.isArray(attributes.branches) &&
      attributes.branches.length <= 10 &&
      attributes.branches.every(
        (branch) =>
          hasAllowedKeys(branch, ['displayName', 'key'], ['key']) &&
          typeof branch.key === 'string' &&
          administrationIdPattern.test(branch.key) &&
          (branch.displayName === undefined || translatable(branch.displayName)),
      ) &&
      Array.isArray(attributes.config) &&
      attributes.config.length <= 50 &&
      attributes.config.every(parameterDefinition) &&
      Array.isArray(attributes.input) &&
      attributes.input.length <= 50 &&
      attributes.input.every(parameterDefinition) &&
      Array.isArray(attributes.output) &&
      attributes.output.length <= 50 &&
      attributes.output.every(parameterDefinition) &&
      translatable(attributes.description) &&
      translatable(attributes.name) &&
      Array.isArray(attributes.requiredScopes) &&
      new Set(attributes.requiredScopes).size === attributes.requiredScopes.length &&
      attributes.requiredScopes.every(
        (scope) => typeof scope === 'string' && /^[a-z][a-z0-9-]*:(?:read|write)$/.test(scope),
      ),
  )

function storedParameter(value: unknown): boolean {
  if (!hasAllowedKeys(value, ['key', 'redacted', 'value'], ['key'])) return false
  if (!boundedString(value.key, 128, false)) return false
  if (value.value !== undefined && !boundedString(value.value, 16 * 1024)) return false
  if (value.redacted !== undefined && value.redacted !== true) return false
  if (value.value !== undefined && value.redacted !== undefined) return false
  return !sensitiveKeyPattern.test(value.key) || value.redacted === true
}

function storedFlow(value: unknown): { restricted: boolean; valid: boolean } {
  const state = { count: 0, restricted: false }
  const steps = (candidate: unknown, depth: number): boolean => {
    if (!Array.isArray(candidate) || depth > 5 || candidate.length > 100) return false
    return candidate.every((step) => {
      if (!isRecord(step) || state.count >= 100) return false
      state.count += 1
      if (hasExactKeys(step as unknown, ['actionId', 'restricted'])) {
        if (!boundedString(step.actionId, 128, false) || step.restricted !== true) return false
        state.restricted = true
        return true
      }
      if (
        !hasAllowedKeys(
          step as unknown,
          ['actionId', 'branches', 'config', 'input', 'output'],
          ['actionId'],
        ) ||
        !actionIds.has(step.actionId as AutomationActionId)
      ) {
        return false
      }
      for (const field of ['config', 'input', 'output'] as const) {
        const parameters = step[field]
        if (
          parameters !== undefined &&
          (!Array.isArray(parameters) ||
            parameters.length > 50 ||
            parameters.some((parameter) => !storedParameter(parameter)))
        ) {
          return false
        }
      }
      if (step.branches === undefined) return true
      return (
        Array.isArray(step.branches) &&
        step.branches.length <= 10 &&
        step.branches.every(
          (branch) =>
            hasExactKeys(branch, ['flow', 'key']) &&
            typeof branch.key === 'string' &&
            administrationIdPattern.test(branch.key) &&
            steps(branch.flow, depth + 1),
        )
      )
    })
  }
  const valid = steps(value, 1)
  return { restricted: state.restricted, valid }
}

function automationTrigger(value: unknown): { restricted: boolean; valid: boolean } {
  if (hasExactKeys(value, ['restricted'])) {
    return { restricted: true, valid: value.restricted === true }
  }
  return {
    restricted: false,
    valid:
      hasExactKeys(value, ['data', 'event']) &&
      (value.event === 'change' || value.event === 'create') &&
      hasExactKeys(value.data, ['type']) &&
      (value.data.type === 'projects' || value.data.type === 'tasks'),
  }
}

function definitionAttributes(
  value: unknown,
  replayed: 'absent' | 'required',
  version = false,
): boolean {
  const required = [
    'archived',
    'description',
    'editable',
    'flow',
    'name',
    'revision',
    'trigger',
    ...(replayed === 'required' ? ['replayed'] : []),
    ...(version ? ['definitionId', 'versionedAt'] : []),
  ]
  const optional = ['createdAt', 'updatedAt']
  if (!hasAllowedKeys(value, [...required, ...optional], required)) return false
  const flow = storedFlow(value.flow)
  const trigger = automationTrigger(value.trigger)
  return (
    typeof value.archived === 'boolean' &&
    boundedString(value.description, 5000) &&
    typeof value.editable === 'boolean' &&
    flow.valid &&
    boundedString(value.name, 200) &&
    typeof value.revision === 'string' &&
    automationDefinitionRevisionPattern.test(value.revision) &&
    trigger.valid &&
    (value.createdAt === undefined || canonicalDate(value.createdAt)) &&
    (value.updatedAt === undefined || canonicalDate(value.updatedAt)) &&
    (replayed === 'absent' ? value.replayed === undefined : typeof value.replayed === 'boolean') &&
    (!version ||
      (typeof value.definitionId === 'string' &&
        administrationIdPattern.test(value.definitionId) &&
        canonicalDate(value.versionedAt))) &&
    (!value.editable || (!flow.restricted && !trigger.restricted))
  )
}

export function automationDefinitionValidator(
  replayed: 'absent' | 'required',
): ResourceValidator<AutomationDefinition> {
  return (value): value is AutomationDefinition =>
    exactResource(value, 'automationDefinition', administrationIdPattern, (attributes) =>
      definitionAttributes(attributes, replayed),
    )
}

export const automationDefinitionVersionValidator: ResourceValidator<
  AutomationDefinitionVersion
> = (value): value is AutomationDefinitionVersion =>
  exactResource(
    value,
    'automationDefinitionVersion',
    automationDefinitionVersionPattern,
    (attributes) =>
      definitionAttributes(attributes, 'absent', true) &&
      isRecord(value) &&
      isRecord(value.attributes) &&
      value.attributes.definitionId !== undefined,
  )

function runAttributes(value: unknown, replayed: 'absent' | 'required') {
  const required = [
    'definition',
    'revision',
    'state',
    ...(replayed === 'required' ? ['replayed'] : []),
  ]
  const optional = ['abortedAt', 'createdAt', 'failedAt', 'finishedAt', 'reference', 'updatedAt']
  if (!hasAllowedKeys(value, [...required, ...optional], required)) return false
  const dates = ['abortedAt', 'createdAt', 'failedAt', 'finishedAt', 'updatedAt'] as const
  return (
    hasExactKeys(value.definition, ['id', 'name']) &&
    typeof value.definition.id === 'string' &&
    administrationIdPattern.test(value.definition.id) &&
    boundedString(value.definition.name, 200) &&
    typeof value.revision === 'string' &&
    automationRunRevisionPattern.test(value.revision) &&
    ['aborted', 'failed', 'running', 'succeeded'].includes(String(value.state)) &&
    dates.every((key) => value[key] === undefined || canonicalDate(value[key])) &&
    (value.reference === undefined ||
      (hasExactKeys(value.reference, ['id', 'type']) &&
        typeof value.reference.id === 'string' &&
        administrationIdPattern.test(value.reference.id) &&
        ['contact', 'project', 'task', 'user', 'workspace'].includes(
          String(value.reference.type),
        ))) &&
    (replayed === 'absent' ? value.replayed === undefined : typeof value.replayed === 'boolean')
  )
}

export function automationRunValidator(
  replayed: 'absent' | 'required',
): ResourceValidator<AutomationRun> {
  return (value): value is AutomationRun =>
    exactResource(value, 'automationRun', administrationIdPattern, (attributes) =>
      runAttributes(attributes, replayed),
    )
}

export const integrationInstallationValidator: ResourceValidator<IntegrationInstallation> = (
  value,
): value is IntegrationInstallation =>
  exactResource(
    value,
    'integrationInstallation',
    administrationIdPattern,
    (attributes) =>
      hasAllowedKeys(
        attributes,
        ['createdAt', 'provider', 'state', 'target', 'updatedAt', 'verification'],
        ['provider', 'state', 'target', 'verification'],
      ) &&
      ['googleCalendar', 'sipgate', 'slack'].includes(String(attributes.provider)) &&
      attributes.state === 'configured' &&
      attributes.verification === 'not_checked' &&
      hasExactKeys(attributes.target, ['id', 'type']) &&
      typeof attributes.target.id === 'string' &&
      administrationIdPattern.test(attributes.target.id) &&
      ['contact', 'project', 'task', 'user', 'workspace'].includes(
        String(attributes.target.type),
      ) &&
      (attributes.createdAt === undefined || canonicalDate(attributes.createdAt)) &&
      (attributes.updatedAt === undefined || canonicalDate(attributes.updatedAt)),
  )

export const systemCapabilityValidator: ResourceValidator<SystemCapability> = (
  value,
): value is SystemCapability =>
  exactResource(
    value,
    'systemCapability',
    publicCapabilityIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['accessible', 'entitled']) &&
      typeof attributes.accessible === 'boolean' &&
      typeof attributes.entitled === 'boolean' &&
      (!attributes.accessible || attributes.entitled),
  )

export const workspaceEntitlementValidator: ResourceValidator<WorkspaceEntitlement> = (
  value,
): value is WorkspaceEntitlement =>
  exactResource(
    value,
    'workspaceEntitlement',
    publicCapabilityIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['accessible', 'enabled']) &&
      typeof attributes.accessible === 'boolean' &&
      typeof attributes.enabled === 'boolean' &&
      (!attributes.accessible || attributes.enabled),
  )

function nullableFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  exclusiveMinimum = false,
) {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      (exclusiveMinimum ? value > minimum : value >= minimum) &&
      value <= maximum)
  )
}

function validWorkspaceName(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 200 &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
  )
}

export const workspaceSettingsValidator: ResourceValidator<WorkspaceSettings> = (
  value,
): value is WorkspaceSettings =>
  exactResource(
    value,
    'workspaceSettings',
    /^current$/,
    (attributes) =>
      hasExactKeys(attributes, [
        'currency',
        'defaultLanguage',
        'defaultPlannedTime',
        'defaultProductivity',
        'defaultShowInScheduling',
        'name',
        'revision',
      ]) &&
      (attributes.currency === null ||
        (typeof attributes.currency === 'string' &&
          ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'NZD', 'USD', 'ZAR'].includes(
            attributes.currency,
          ))) &&
      (attributes.defaultLanguage === null ||
        (typeof attributes.defaultLanguage === 'string' &&
          ['de', 'de-XX', 'en'].includes(attributes.defaultLanguage))) &&
      nullableFiniteNumber(attributes.defaultPlannedTime, 0, 525_600) &&
      nullableFiniteNumber(attributes.defaultProductivity, 0, 200, true) &&
      (attributes.defaultShowInScheduling === null ||
        typeof attributes.defaultShowInScheduling === 'boolean') &&
      validWorkspaceName(attributes.name) &&
      typeof attributes.revision === 'string' &&
      workspaceSettingsRevisionPattern.test(attributes.revision),
  )

export function isWorkspaceSettingsUpdate(value: unknown): value is WorkspaceSettingsUpdate {
  if (
    !hasAllowedKeys(
      value,
      [
        'currency',
        'defaultLanguage',
        'defaultPlannedTime',
        'defaultProductivity',
        'defaultShowInScheduling',
        'name',
      ],
      [],
    ) ||
    Object.keys(value).length === 0
  ) {
    return false
  }
  return (
    (value.currency === undefined ||
      (typeof value.currency === 'string' &&
        ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'NZD', 'USD', 'ZAR'].includes(value.currency))) &&
    (value.defaultLanguage === undefined ||
      (typeof value.defaultLanguage === 'string' &&
        ['de', 'de-XX', 'en'].includes(value.defaultLanguage))) &&
    (value.defaultPlannedTime === undefined ||
      (nullableFiniteNumber(value.defaultPlannedTime, 0, 525_600) &&
        value.defaultPlannedTime !== null)) &&
    (value.defaultProductivity === undefined ||
      (nullableFiniteNumber(value.defaultProductivity, 0, 200, true) &&
        value.defaultProductivity !== null)) &&
    (value.defaultShowInScheduling === undefined ||
      typeof value.defaultShowInScheduling === 'boolean') &&
    (value.name === undefined || validWorkspaceName(value.name))
  )
}

export const eventDefinitionValidator: ResourceValidator<EventDefinition> = (
  value,
): value is EventDefinition =>
  exactResource(value, 'eventDefinition', eventDefinitionIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, ['channel', 'operation', 'requiredScopes', 'resourceType']) ||
      !uniqueStrings(attributes.requiredScopes, 20, (scope) => scopePattern.test(scope))
    ) {
      return false
    }
    return (
      attributes.channel === 'webhook' &&
      attributes.operation === null &&
      attributes.resourceType === null
    )
  })

export const timeEntryBillingValidator: ResourceValidator<TimeEntryBilling> = (
  value,
): value is TimeEntryBilling =>
  exactResource(
    value,
    'timeEntryBilling',
    administrationIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['billed', 'billedAt', 'revision']) &&
      typeof attributes.billed === 'boolean' &&
      nullableCanonicalDate(attributes.billedAt) &&
      (attributes.billed ? attributes.billedAt !== null : attributes.billedAt === null) &&
      typeof attributes.revision === 'string' &&
      timeEntryBillingRevisionPattern.test(attributes.revision),
  )

export const webhookSecretRotationValidator: ResourceValidator<WebhookSecretRotation> = (
  value,
): value is WebhookSecretRotation =>
  exactResource(
    value,
    'webhookSecretRotation',
    webhookIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['replayed', 'revision', 'signingSecret']) &&
      typeof attributes.replayed === 'boolean' &&
      typeof attributes.revision === 'string' &&
      webhookRevisionPattern.test(attributes.revision) &&
      typeof attributes.signingSecret === 'string' &&
      webhookSigningSecretPattern.test(attributes.signingSecret),
  )

export const webhookTestDeliveryValidator: ResourceValidator<WebhookTestDelivery> = (
  value,
): value is WebhookTestDelivery =>
  exactResource(
    value,
    'webhookTestDelivery',
    /^[A-Za-z0-9_-]{1,256}$/,
    (attributes) =>
      hasExactKeys(attributes, ['replayed', 'test', 'webhookId']) &&
      typeof attributes.replayed === 'boolean' &&
      attributes.test === true &&
      typeof attributes.webhookId === 'string' &&
      webhookIdPattern.test(attributes.webhookId),
  )

function safeWebhookUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}

function webhookActions(value: unknown) {
  return uniqueStrings(value, 100, (action) => /^[A-Za-z0-9_.:-]{1,100}$/.test(action))
}

export function webhookValidator(signingSecret: 'absent' | 'required'): ResourceValidator<Webhook> {
  return (value): value is Webhook =>
    exactResource(
      value,
      'webhook',
      webhookIdPattern,
      (attributes) =>
        hasExactKeys(attributes, [
          'actions',
          'disabled',
          'failCount',
          'lastStatus',
          'revision',
          ...(signingSecret === 'required' ? ['signingSecret'] : []),
          'url',
          'version',
        ]) &&
        webhookActions(attributes.actions) &&
        typeof attributes.disabled === 'boolean' &&
        Number.isSafeInteger(attributes.failCount) &&
        Number(attributes.failCount) >= 0 &&
        (attributes.lastStatus === null ||
          (Number.isSafeInteger(attributes.lastStatus) &&
            Number(attributes.lastStatus) >= 100 &&
            Number(attributes.lastStatus) <= 599)) &&
        typeof attributes.revision === 'string' &&
        webhookRevisionPattern.test(attributes.revision) &&
        (signingSecret === 'absent' ||
          (typeof attributes.signingSecret === 'string' &&
            webhookSigningSecretPattern.test(attributes.signingSecret))) &&
        safeWebhookUrl(attributes.url) &&
        attributes.version === 2,
    )
}

export function isWebhookCreate(value: unknown): value is WebhookCreate {
  return (
    hasExactKeys(value, ['actions', 'url']) &&
    webhookActions(value.actions) &&
    value.actions.length > 0 &&
    safeWebhookUrl(value.url)
  )
}

export function isWebhookUpdate(value: unknown): value is WebhookUpdate {
  return (
    hasAllowedKeys(value, ['actions', 'disabled', 'url'], []) &&
    Object.keys(value).length > 0 &&
    (value.actions === undefined || (webhookActions(value.actions) && value.actions.length > 0)) &&
    (value.disabled === undefined || typeof value.disabled === 'boolean') &&
    (value.url === undefined || safeWebhookUrl(value.url))
  )
}

function recurrenceJsonObject(value: unknown, maximumBytes = 256 * 1024) {
  if (!isRecord(value) || Object.keys(value).length > 256) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximumBytes
  } catch {
    return false
  }
}

const recurrenceLocalDatePattern = /^\d{4}-\d{2}-\d{2}$/
const recurrenceLocalDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/
const recurrenceNodePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const recurrenceReferencePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const recurrenceEventTypePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const recurrenceConditionRefPattern =
  /^(?:event\.[A-Za-z0-9_.:-]+|occurrence\.(?:scheduledFor|scheduledDate)|previousOccurrence\.(?:archived|completed|exists|state)|project\.(?:active|archived|completed|exists)|series\.(?:status|occurrenceCount)|customField\.[A-Za-z0-9_.:-]+)$/
const recurrenceDurationUnits = ['minute', 'hour', 'day', 'week', 'month', 'year', 'business-day']

function recurrenceInteger(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function recurrenceIntegerArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumItems: number,
  excludeZero = false,
) {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every(
      (item) => recurrenceInteger(item, minimum, maximum) && (!excludeZero || item !== 0),
    ) &&
    new Set(value).size === value.length
  )
}

function recurrenceDuration(value: unknown, nonNegative = false) {
  return (
    hasExactKeys(value, ['unit', 'value']) &&
    recurrenceDurationUnits.includes(String(value.unit)) &&
    recurrenceInteger(value.value, nonNegative ? 0 : -1_000_000, 1_000_000) &&
    (value.unit !== 'business-day' ||
      recurrenceInteger(value.value, nonNegative ? 0 : -10_000, 10_000))
  )
}

function recurrenceCalendarRule(value: unknown) {
  if (
    !hasAllowedKeys(
      value,
      [
        'byHour',
        'byMinute',
        'byMonth',
        'byMonthDay',
        'bySetPosition',
        'byWeekDay',
        'frequency',
        'interval',
        'invalidDayHandling',
        'startLocal',
        'weekStart',
      ],
      ['frequency', 'interval', 'startLocal'],
    )
  )
    return false
  return (
    ['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'].includes(
      String(value.frequency),
    ) &&
    recurrenceInteger(value.interval, 1, 1_000_000) &&
    recurrenceLocalDateTimePattern.test(String(value.startLocal)) &&
    (value.byHour === undefined || recurrenceIntegerArray(value.byHour, 0, 23, 24)) &&
    (value.byMinute === undefined || recurrenceIntegerArray(value.byMinute, 0, 59, 60)) &&
    (value.byMonth === undefined || recurrenceIntegerArray(value.byMonth, 1, 12, 12)) &&
    (value.byMonthDay === undefined ||
      recurrenceIntegerArray(value.byMonthDay, -31, 31, 62, true)) &&
    (value.bySetPosition === undefined ||
      recurrenceIntegerArray(value.bySetPosition, -366, 366, 732, true)) &&
    (value.byWeekDay === undefined || recurrenceIntegerArray(value.byWeekDay, 0, 6, 7)) &&
    (value.invalidDayHandling === undefined ||
      ['next-valid-day', 'omit', 'previous-valid-day'].includes(
        String(value.invalidDayHandling),
      )) &&
    (value.weekStart === undefined || recurrenceInteger(value.weekStart, 0, 6))
  )
}

type RecurrenceCandidateState = { nodeIds: Set<string>; nodes: number }

function recurrenceCandidate(value: unknown, state: RecurrenceCandidateState, depth = 0): boolean {
  if (!isRecord(value) || depth > 12 || state.nodes >= 128) return false
  state.nodes += 1
  if (value.op === 'union' || value.op === 'intersection') {
    return (
      hasExactKeys(value, ['op', 'sources']) &&
      Array.isArray(value.sources) &&
      value.sources.length >= 1 &&
      value.sources.length <= 32 &&
      value.sources.every((source) => recurrenceCandidate(source, state, depth + 1))
    )
  }
  if (value.op === 'difference') {
    return (
      hasExactKeys(value, ['exclude', 'include', 'op']) &&
      recurrenceCandidate(value.include, state, depth + 1) &&
      recurrenceCandidate(value.exclude, state, depth + 1)
    )
  }
  if (value.op === 'deduplicate') {
    return (
      hasExactKeys(value, ['granularity', 'op', 'source']) &&
      ['instant', 'day', 'minute'].includes(String(value.granularity)) &&
      recurrenceCandidate(value.source, state, depth + 1)
    )
  }
  if (
    !recurrenceNodePattern.test(String(value.nodeId)) ||
    state.nodeIds.has(String(value.nodeId))
  ) {
    return false
  }
  state.nodeIds.add(String(value.nodeId))
  if (value.op === 'calendarRule') {
    return hasExactKeys(value, ['nodeId', 'op', 'rule']) && recurrenceCalendarRule(value.rule)
  }
  if (value.op === 'dateSet') {
    return (
      hasExactKeys(value, ['dates', 'nodeId', 'op']) &&
      Array.isArray(value.dates) &&
      value.dates.length >= 1 &&
      value.dates.length <= 500 &&
      value.dates.every((date) => recurrenceLocalDateTimePattern.test(String(date)))
    )
  }
  if (value.op === 'monthSet') {
    return (
      hasExactKeys(value, ['months', 'nodeId', 'op']) &&
      recurrenceIntegerArray(value.months, 1, 12, 12) &&
      (value.months as unknown[]).length >= 1
    )
  }
  if (value.op === 'sequence') {
    return (
      hasExactKeys(value, ['anchorLocal', 'intervals', 'nodeId', 'op']) &&
      recurrenceLocalDateTimePattern.test(String(value.anchorLocal)) &&
      Array.isArray(value.intervals) &&
      value.intervals.length >= 1 &&
      value.intervals.length <= 500 &&
      value.intervals.every((item) => recurrenceDuration(item, true))
    )
  }
  if (value.op === 'afterOccurrenceEvent') {
    return (
      hasAllowedKeys(
        value,
        ['completionMode', 'delay', 'event', 'nodeId', 'op'],
        ['event', 'nodeId', 'op'],
      ) &&
      ['completed', 'created', 'reopened'].includes(String(value.event)) &&
      (value.completionMode === undefined ||
        ['every-completion-transition', 'first-completion-only'].includes(
          String(value.completionMode),
        )) &&
      (value.delay === undefined || recurrenceDuration(value.delay, true))
    )
  }
  if (value.op === 'afterProjectEvent') {
    return (
      hasAllowedKeys(
        value,
        ['delay', 'event', 'nodeId', 'op', 'projectId'],
        ['event', 'nodeId', 'op', 'projectId'],
      ) &&
      ['archived', 'completed', 'created', 'reopened', 'restored'].includes(String(value.event)) &&
      recurrenceReferencePattern.test(String(value.projectId)) &&
      (value.delay === undefined || recurrenceDuration(value.delay, true))
    )
  }
  return (
    value.op === 'externalEvent' &&
    hasAllowedKeys(
      value,
      ['delay', 'eventType', 'nodeId', 'op', 'sourceId'],
      ['eventType', 'nodeId', 'op'],
    ) &&
    recurrenceEventTypePattern.test(String(value.eventType)) &&
    (value.sourceId === undefined || recurrenceNodePattern.test(String(value.sourceId))) &&
    (value.delay === undefined || recurrenceDuration(value.delay, true))
  )
}

function recurrenceTransform(value: unknown) {
  if (!isRecord(value)) return false
  if (value.op === 'offset') {
    return (
      hasAllowedKeys(value, ['op', 'unit', 'unitMode', 'value'], ['op', 'unit', 'value']) &&
      recurrenceDuration({ unit: value.unit, value: value.value }) &&
      (value.unitMode === undefined || ['elapsed', 'wall-clock'].includes(String(value.unitMode)))
    )
  }
  if (value.op === 'nthBusinessDay') {
    return (
      hasAllowedKeys(
        value,
        ['calendarBinding', 'op', 'period', 'position'],
        ['op', 'period', 'position'],
      ) &&
      ['month', 'quarter', 'year'].includes(String(value.period)) &&
      recurrenceInteger(value.position, -366, 366) &&
      value.position !== 0 &&
      (value.calendarBinding === undefined ||
        ['assignee', 'project', 'series'].includes(String(value.calendarBinding)))
    )
  }
  if (value.op === 'shiftToBusinessTime' || value.op === 'snapToWorkingTime') {
    return (
      hasAllowedKeys(
        value,
        ['calendarBinding', 'direction', 'includeAbsences', 'op'],
        ['direction', 'op'],
      ) &&
      ['next', 'previous'].includes(String(value.direction)) &&
      (value.includeAbsences === undefined || typeof value.includeAbsences === 'boolean') &&
      (value.calendarBinding === undefined ||
        ['assignee', 'project', 'series'].includes(String(value.calendarBinding)))
    )
  }
  if (value.op === 'setLocalTime') {
    return (
      hasExactKeys(value, ['hour', 'minute', 'op']) &&
      recurrenceInteger(value.hour, 0, 23) &&
      recurrenceInteger(value.minute, 0, 59)
    )
  }
  if (value.op === 'limit') {
    return (
      hasAllowedKeys(value, ['count', 'op', 'start', 'until'], ['op']) &&
      Object.keys(value).length > 1 &&
      (value.count === undefined || recurrenceInteger(value.count, 1, 1_000_000)) &&
      (value.start === undefined || boundedString(value.start, 32, false)) &&
      (value.until === undefined || boundedString(value.until, 32, false))
    )
  }
  if (value.op === 'excludeDateSet') {
    return (
      hasExactKeys(value, ['dates', 'op']) &&
      Array.isArray(value.dates) &&
      value.dates.length >= 1 &&
      value.dates.length <= 500 &&
      value.dates.every((date) => recurrenceLocalDatePattern.test(String(date)))
    )
  }
  if (value.op === 'excludePeriod') {
    return (
      hasExactKeys(value, ['end', 'op', 'start']) &&
      boundedString(value.start, 32, false) &&
      boundedString(value.end, 32, false)
    )
  }
  return (
    value.op === 'mapToDueAndPlanningDates' &&
    hasAllowedKeys(value, ['dueOffset', 'op', 'plannedEndOffset', 'plannedStartOffset'], ['op']) &&
    (value.dueOffset === undefined || recurrenceDuration(value.dueOffset)) &&
    (value.plannedEndOffset === undefined || recurrenceDuration(value.plannedEndOffset)) &&
    (value.plannedStartOffset === undefined || recurrenceDuration(value.plannedStartOffset))
  )
}

function recurrenceConditionValue(value: unknown) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value)
  }
  return hasExactKeys(value, ['ref']) && recurrenceConditionRefPattern.test(String(value.ref))
}

function recurrenceCondition(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 12) return false
  if (value.op === 'all' || value.op === 'any') {
    return (
      hasExactKeys(value, ['conditions', 'op']) &&
      Array.isArray(value.conditions) &&
      value.conditions.length <= 64 &&
      value.conditions.every((condition) => recurrenceCondition(condition, depth + 1))
    )
  }
  if (value.op === 'not') {
    return (
      hasExactKeys(value, ['condition', 'op']) && recurrenceCondition(value.condition, depth + 1)
    )
  }
  if (value.op === 'exists') {
    return hasExactKeys(value, ['op', 'value']) && recurrenceConditionValue(value.value)
  }
  if (
    !['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in'].includes(String(value.op)) ||
    !hasExactKeys(value, ['left', 'op', 'right']) ||
    !recurrenceConditionValue(value.left)
  )
    return false
  if (value.op === 'in') {
    return (
      Array.isArray(value.right) &&
      value.right.length <= 100 &&
      value.right.every(recurrenceConditionValue)
    )
  }
  return recurrenceConditionValue(value.right)
}

function recurrencePolicy(value: unknown) {
  if (
    !hasExactKeys(value, [
      'candidates',
      'conditions',
      'engineVersion',
      'limits',
      'materialization',
      'schemaVersion',
      'timeBasis',
      'transforms',
    ]) ||
    value.engineVersion !== 'recurrence-v1' ||
    value.schemaVersion !== 1
  )
    return false
  const candidateState = { nodeIds: new Set<string>(), nodes: 0 }
  return (
    recurrenceCandidate(value.candidates, candidateState) &&
    Array.isArray(value.conditions) &&
    value.conditions.length <= 64 &&
    value.conditions.every((condition) => recurrenceCondition(condition)) &&
    hasExactKeys(value.limits, ['maxOccurrences', 'until']) &&
    (value.limits.maxOccurrences === null ||
      recurrenceInteger(value.limits.maxOccurrences, 1, 10_000_000)) &&
    (value.limits.until === null || boundedString(value.limits.until, 32, false)) &&
    hasAllowedKeys(
      value.materialization,
      ['catchUp', 'catchUpLimit', 'lead', 'overlap'],
      ['catchUp', 'lead', 'overlap'],
    ) &&
    ['all', 'bounded', 'latest', 'none'].includes(String(value.materialization.catchUp)) &&
    (value.materialization.catchUp === 'bounded'
      ? recurrenceInteger(value.materialization.catchUpLimit, 1, 100)
      : value.materialization.catchUpLimit === undefined) &&
    recurrenceDuration(value.materialization.lead, true) &&
    ['allow', 'defer', 'latest-only', 'pause-series', 'skip'].includes(
      String(value.materialization.overlap),
    ) &&
    hasExactKeys(value.timeBasis, ['disambiguation', 'mode', 'timeZone']) &&
    ['compatible', 'earlier', 'later', 'reject'].includes(String(value.timeBasis.disambiguation)) &&
    ['elapsed', 'wall-clock'].includes(String(value.timeBasis.mode)) &&
    boundedString(value.timeBasis.timeZone, 128, false) &&
    Array.isArray(value.transforms) &&
    value.transforms.length <= 64 &&
    value.transforms.every(recurrenceTransform)
  )
}

function recurrenceCustomFieldValue(value: unknown) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value)
  }
  return (
    Array.isArray(value) &&
    value.length <= 250 &&
    value.every((item) => item === null || ['boolean', 'number', 'string'].includes(typeof item))
  )
}

function recurrenceCustomFieldValues(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(
      ([key, item]) => recurrenceReferencePattern.test(key) && recurrenceCustomFieldValue(item),
    )
  )
}

function recurrenceSubTasks(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length <= 500 &&
    value.every(
      (subTask) =>
        hasAllowedKeys(subTask, ['order', 'title'], ['title']) &&
        boundedString(subTask.title, 5000, false) &&
        (subTask.order === undefined ||
          (typeof subTask.order === 'number' &&
            Number.isFinite(subTask.order) &&
            Math.abs(subTask.order) <= 100_000_000)),
    )
  )
}

function recurrenceTemplate(value: unknown, requireName = true) {
  if (
    !hasAllowedKeys(
      value,
      [
        'billable',
        'contactId',
        'customFieldValues',
        'description',
        'descriptionFormat',
        'groupId',
        'listId',
        'name',
        'personalListId',
        'plannedTime',
        'projectId',
        'serviceId',
        'subscriberIds',
        'subTasks',
        'tagIds',
        'userId',
      ],
      requireName ? ['name'] : [],
    )
  )
    return false
  const idFields = [
    'contactId',
    'groupId',
    'listId',
    'personalListId',
    'projectId',
    'serviceId',
    'userId',
  ]
  return (
    (!requireName || boundedString(value.name, 1000, false)) &&
    (value.name === undefined || boundedString(value.name, 1000, false)) &&
    (value.billable === undefined || typeof value.billable === 'boolean') &&
    (value.description === undefined || boundedString(value.description, 200_000)) &&
    (value.descriptionFormat === undefined ||
      ['markdown-v1', 'plain-text'].includes(String(value.descriptionFormat))) &&
    (value.plannedTime === undefined ||
      (typeof value.plannedTime === 'number' &&
        Number.isFinite(value.plannedTime) &&
        value.plannedTime >= 0 &&
        value.plannedTime <= 100_000_000)) &&
    idFields.every(
      (key) => value[key] === undefined || recurrenceReferencePattern.test(String(value[key])),
    ) &&
    (value.subscriberIds === undefined ||
      sortedUniqueStrings(value.subscriberIds, 250, (id) => recurrenceReferencePattern.test(id))) &&
    (value.subTasks === undefined || recurrenceSubTasks(value.subTasks)) &&
    (value.tagIds === undefined ||
      sortedUniqueStrings(value.tagIds, 250, (id) => recurrenceReferencePattern.test(id))) &&
    (value.customFieldValues === undefined ||
      recurrenceCustomFieldValues(value.customFieldValues)) &&
    recurrenceJsonObject(value)
  )
}

function recurrenceOccurrenceOverride(value: unknown) {
  return (
    hasAllowedKeys(
      value,
      ['action', 'placeholderToken', 'scheduledForLocal', 'templatePatch'],
      ['action'],
    ) &&
    ['materialize', 'skip'].includes(String(value.action)) &&
    (value.placeholderToken === undefined ||
      (boundedString(value.placeholderToken, 32 * 1024, false) &&
        taskRecurrencePlaceholderTokenPattern.test(String(value.placeholderToken)))) &&
    (value.scheduledForLocal === undefined ||
      recurrenceLocalDateTimePattern.test(String(value.scheduledForLocal))) &&
    (value.templatePatch === undefined || recurrenceTemplate(value.templatePatch, false))
  )
}

function recurrenceCardDates(value: unknown) {
  return (
    hasAllowedKeys(value, ['dueDate', 'plannedEnd', 'plannedStart'], []) &&
    Object.values(value).every(canonicalDate)
  )
}

function recurrenceDefinition(value: unknown) {
  if (
    !hasExactKeys(value, [
      'costClass',
      'definitionHash',
      'engineVersion',
      'id',
      'policy',
      'schemaVersion',
      'summary',
      'template',
      'version',
    ])
  )
    return false
  return (
    ['low', 'medium', 'high', 'async'].includes(String(value.costClass)) &&
    taskRecurrenceRevisionPattern.test(String(value.definitionHash)) &&
    value.engineVersion === 'recurrence-v1' &&
    taskRecurrenceIdPattern.test(String(value.id)) &&
    recurrencePolicy(value.policy) &&
    value.schemaVersion === 1 &&
    recurrenceJsonObject(value.summary, 32 * 1024) &&
    recurrenceTemplate(value.template) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1
  )
}

export const taskRecurrenceValidator: ResourceValidator<TaskRecurrence> = (
  value,
): value is TaskRecurrence =>
  exactResource(
    value,
    'taskRecurrence',
    taskRecurrenceIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'attentionCode',
        'createdAt',
        'currentDefinition',
        'developerUpdatedAt',
        'name',
        'owner',
        'replayed',
        'resourceContext',
        'revision',
        'status',
        'updatedAt',
      ]) &&
      (attributes.attentionCode === null || boundedString(attributes.attentionCode, 1000, false)) &&
      canonicalDate(attributes.createdAt) &&
      recurrenceDefinition(attributes.currentDefinition) &&
      canonicalDate(attributes.developerUpdatedAt) &&
      (attributes.name === null || boundedString(attributes.name, 1000)) &&
      hasExactKeys(attributes.owner, ['id', 'kind']) &&
      taskRecurrenceIdPattern.test(String(attributes.owner.id)) &&
      ['developerPrincipal', 'user'].includes(String(attributes.owner.kind)) &&
      typeof attributes.replayed === 'boolean' &&
      recurrenceJsonObject(attributes.resourceContext, 32 * 1024) &&
      taskRecurrenceRevisionPattern.test(String(attributes.revision)) &&
      ['active', 'paused', 'suspended', 'needs_attention', 'ended', 'archived'].includes(
        String(attributes.status),
      ) &&
      canonicalDate(attributes.updatedAt),
  )

export const taskRecurrenceVersionValidator: ResourceValidator<TaskRecurrenceVersion> = (
  value,
): value is TaskRecurrenceVersion =>
  exactResource(
    value,
    'taskRecurrenceVersion',
    taskRecurrenceIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'changeReason',
        'costClass',
        'createdAt',
        'createdBy',
        'definitionHash',
        'effectiveFromOccurrenceKey',
        'engineVersion',
        'policy',
        'schemaVersion',
        'seriesId',
        'summary',
        'template',
        'version',
      ]) &&
      (attributes.changeReason === null || boundedString(attributes.changeReason, 1000)) &&
      ['low', 'medium', 'high', 'async'].includes(String(attributes.costClass)) &&
      canonicalDate(attributes.createdAt) &&
      taskRecurrenceIdPattern.test(String(attributes.createdBy)) &&
      taskRecurrenceRevisionPattern.test(String(attributes.definitionHash)) &&
      (attributes.effectiveFromOccurrenceKey === null ||
        taskRecurrenceIdPattern.test(String(attributes.effectiveFromOccurrenceKey))) &&
      attributes.engineVersion === 'recurrence-v1' &&
      recurrencePolicy(attributes.policy) &&
      attributes.schemaVersion === 1 &&
      taskRecurrenceIdPattern.test(String(attributes.seriesId)) &&
      recurrenceJsonObject(attributes.summary, 32 * 1024) &&
      recurrenceTemplate(attributes.template) &&
      Number.isSafeInteger(attributes.version) &&
      Number(attributes.version) >= 1,
  )

export const taskRecurrenceOccurrenceValidator: ResourceValidator<TaskRecurrenceOccurrence> = (
  value,
): value is TaskRecurrenceOccurrence =>
  exactResource(
    value,
    'taskRecurrenceOccurrence',
    taskRecurrenceIdPattern,
    (attributes) =>
      hasExactKeys(attributes, [
        'attempts',
        'cardId',
        'decision',
        'definitionVersionId',
        'lastErrorCode',
        'materializeAt',
        'materializedAt',
        'occurrenceKey',
        'override',
        'revision',
        'scheduledFor',
        'scheduledForLocal',
        'seriesId',
        'state',
        'timeZone',
        'updatedAt',
      ]) &&
      Number.isSafeInteger(attributes.attempts) &&
      Number(attributes.attempts) >= 0 &&
      nullableId(attributes.cardId) &&
      (attributes.decision === null || recurrenceJsonObject(attributes.decision, 32 * 1024)) &&
      taskRecurrenceIdPattern.test(String(attributes.definitionVersionId)) &&
      (attributes.lastErrorCode === null || boundedString(attributes.lastErrorCode, 1000, false)) &&
      canonicalDate(attributes.materializeAt) &&
      nullableCanonicalDate(attributes.materializedAt) &&
      taskRecurrenceOccurrenceKeyPattern.test(String(attributes.occurrenceKey)) &&
      (attributes.override === null || recurrenceOccurrenceOverride(attributes.override)) &&
      taskRecurrenceRevisionPattern.test(String(attributes.revision)) &&
      canonicalDate(attributes.scheduledFor) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(String(attributes.scheduledForLocal)) &&
      taskRecurrenceIdPattern.test(String(attributes.seriesId)) &&
      ['planned', 'claimed', 'materialized', 'skipped', 'blocked', 'failed'].includes(
        String(attributes.state),
      ) &&
      boundedString(attributes.timeZone, 128, false) &&
      canonicalDate(attributes.updatedAt),
  )

export const taskRecurrencePreviewValidator: ResourceValidator<TaskRecurrencePreview> = (
  value,
): value is TaskRecurrencePreview =>
  exactResource(
    value,
    'taskRecurrencePreview',
    taskRecurrenceIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['costClass', 'definitionHash', 'occurrences', 'summary']) &&
      (attributes.costClass === null ||
        ['low', 'medium', 'high', 'async'].includes(String(attributes.costClass))) &&
      taskRecurrenceRevisionPattern.test(String(attributes.definitionHash)) &&
      Array.isArray(attributes.occurrences) &&
      attributes.occurrences.length <= 100 &&
      attributes.occurrences.every(
        (occurrence) =>
          hasExactKeys(occurrence, [
            'cardDates',
            'occurrenceKey',
            'placeholderToken',
            'provenance',
            'scheduledFor',
            'scheduledForLocal',
            'timeZone',
          ]) &&
          recurrenceCardDates(occurrence.cardDates) &&
          taskRecurrenceOccurrenceKeyPattern.test(String(occurrence.occurrenceKey)) &&
          (occurrence.placeholderToken === null ||
            (boundedString(occurrence.placeholderToken, 32 * 1024, false) &&
              taskRecurrencePlaceholderTokenPattern.test(String(occurrence.placeholderToken)))) &&
          Array.isArray(occurrence.provenance) &&
          occurrence.provenance.length <= 100 &&
          occurrence.provenance.every((item) => boundedString(item, 256, false)) &&
          canonicalDate(occurrence.scheduledFor) &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(String(occurrence.scheduledForLocal)) &&
          boundedString(occurrence.timeZone, 128, false),
      ) &&
      recurrenceJsonObject(attributes.summary, 32 * 1024),
  )

function recurrenceOperationProgress(value: unknown) {
  return (
    value === null ||
    (hasAllowedKeys(value, ['current', 'total'], ['current']) &&
      typeof value.current === 'number' &&
      Number.isSafeInteger(value.current) &&
      value.current >= 0 &&
      (value.total === undefined ||
        (typeof value.total === 'number' &&
          Number.isSafeInteger(value.total) &&
          value.total >= value.current)))
  )
}

export const taskRecurrenceOperationValidator: ResourceValidator<TaskRecurrenceOperation> = (
  value,
): value is TaskRecurrenceOperation =>
  exactResource(value, 'taskRecurrenceOperation', taskRecurrenceIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'completedAt',
        'createdAt',
        'errorCode',
        'operationType',
        'progress',
        'result',
        'seriesId',
        'status',
        'updatedAt',
      ]) ||
      !nullableCanonicalDate(attributes.completedAt) ||
      !canonicalDate(attributes.createdAt) ||
      !['catchUp', 'preview', 'recheck', 'repair'].includes(String(attributes.operationType)) ||
      !['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(
        String(attributes.status),
      ) ||
      !canonicalDate(attributes.updatedAt)
    )
      return false
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(String(attributes.status))
    return (
      recurrenceOperationProgress(attributes.progress) &&
      (attributes.operationType === 'preview'
        ? attributes.seriesId === null
        : nullableId(attributes.seriesId) && attributes.seriesId !== null) &&
      (terminal ? attributes.completedAt !== null : attributes.completedAt === null) &&
      (attributes.status === 'succeeded'
        ? recurrenceJsonObject(attributes.result, 64 * 1024)
        : attributes.result === null) &&
      (attributes.status === 'failed'
        ? boundedString(attributes.errorCode, 1000, false)
        : attributes.errorCode === null)
    )
  })

export const taskRecurrenceEventValidator: ResourceValidator<TaskRecurrenceEvent> = (
  value,
): value is TaskRecurrenceEvent =>
  exactResource(
    value,
    'taskRecurrenceEvent',
    taskRecurrenceIdPattern,
    (attributes) =>
      hasExactKeys(attributes, ['acceptedAt']) && canonicalDate(attributes.acceptedAt),
  )

export function assertRevisionEtag(
  transport: Readonly<TransportMetadata>,
  revision: string,
  label: string,
) {
  if (transport.headers.etag !== `"${revision}"`) invalid(`${label} ETag`)
}

export function canonicalAdministrationEtag(value: string) {
  return canonicalEtag(value, administrationRevisionPattern, 'administration')
}

export function canonicalAutomationDefinitionEtag(value: string) {
  return canonicalEtag(value, automationDefinitionRevisionPattern, 'automation-definition')
}

export function canonicalAutomationRunEtag(value: string) {
  return canonicalEtag(value, automationRunRevisionPattern, 'automation-run')
}

export function canonicalWorkspaceSettingsEtag(value: string) {
  return canonicalEtag(value, workspaceSettingsRevisionPattern, 'workspace-settings')
}

export function canonicalWebhookEtag(value: string) {
  return canonicalEtag(value, webhookRevisionPattern, 'webhook')
}

export function canonicalTimeEntryBillingEtag(value: string) {
  return canonicalEtag(value, timeEntryBillingRevisionPattern, 'time-entry billing')
}

export function isValidIdempotencyKey(value: string) {
  return /^[\x21-\x7e]{1,128}$/.test(value)
}

export function isValidWebhookId(value: string) {
  return webhookIdPattern.test(value)
}

function canonicalEtag(value: string, pattern: RegExp, label: string) {
  const revision = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  if (!pattern.test(revision)) {
    throw new TeamGridClientError(
      'invalid_arguments',
      `${label} ifMatch must be a canonical revision or one strong ETag.`,
    )
  }
  return `"${revision}"`
}

export function isDownloadIntentToken(value: string) {
  return downloadIntentPattern.test(value)
}

export function isSafeExportFileName(value: string) {
  return safeFileName(value)
}

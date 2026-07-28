import { TeamGridClientError } from './errors.js'
import type {
  Project,
  ProjectLifecycleOperation,
  ProjectSharing,
  ProjectTemplate,
  ProjectTemplateInstantiation,
  Task,
} from './types.js'

type RecordValue = Record<string, unknown>

const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const templateIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const anyStringPattern = /^[\s\S]*$/
const developerRevisionPattern = /^[a-f0-9]{64}$/

function invalidResponse(label: string, detail: string): never {
  throw new TeamGridClientError(
    'invalid_api_response',
    `The TeamGrid API returned an invalid ${label} response: ${detail}.`,
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

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !canonicalDatePattern.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function nullableDate(value: unknown): value is string | null {
  return value === null || canonicalDate(value)
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function nullableId(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function finiteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function exactResource(
  value: unknown,
  type: 'project' | 'projectSharing' | 'projectTemplate' | 'task',
  idPattern: RegExp,
  attributes: (value: unknown) => boolean,
) {
  return (
    hasExactKeys(value, ['attributes', 'id', 'type']) &&
    value.type === type &&
    typeof value.id === 'string' &&
    idPattern.test(value.id) &&
    attributes(value.attributes)
  )
}

export const taskValidator = (value: unknown): value is Task =>
  exactResource(value, 'task', anyStringPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'archived',
        'archivedAt',
        'assigneeId',
        'billable',
        'completed',
        'completedAt',
        'completedById',
        'commentsCount',
        'contactId',
        'createdAt',
        'createdById',
        'description',
        'developerRevision',
        'developerUpdatedAt',
        'duplicateOfTaskId',
        'dueAt',
        'filesCount',
        'groupId',
        'listId',
        'listOrder',
        'name',
        'order',
        'personalListId',
        'personalListOrder',
        'plannedEndAt',
        'plannedMinutes',
        'plannedStartAt',
        'projectId',
        'serviceId',
        'subscriberIds',
        'subtasksCount',
        'subtasks',
        'tagIds',
        'trackingActive',
        'updatedAt',
      ])
    ) {
      return false
    }
    return (
      typeof attributes.archived === 'boolean' &&
      nullableDate(attributes.archivedAt) &&
      nullableId(attributes.assigneeId) &&
      (attributes.billable === null || typeof attributes.billable === 'boolean') &&
      typeof attributes.completed === 'boolean' &&
      nullableDate(attributes.completedAt) &&
      nullableId(attributes.completedById) &&
      Number.isSafeInteger(attributes.commentsCount) &&
      (attributes.commentsCount as number) >= 0 &&
      nullableId(attributes.contactId) &&
      nullableDate(attributes.createdAt) &&
      nullableId(attributes.createdById) &&
      typeof attributes.description === 'string' &&
      typeof attributes.developerRevision === 'string' &&
      developerRevisionPattern.test(attributes.developerRevision) &&
      canonicalDate(attributes.developerUpdatedAt) &&
      nullableId(attributes.duplicateOfTaskId) &&
      nullableDate(attributes.dueAt) &&
      Number.isSafeInteger(attributes.filesCount) &&
      (attributes.filesCount as number) >= 0 &&
      nullableId(attributes.groupId) &&
      nullableId(attributes.listId) &&
      finiteNumberOrNull(attributes.listOrder) &&
      typeof attributes.name === 'string' &&
      finiteNumberOrNull(attributes.order) &&
      nullableId(attributes.personalListId) &&
      finiteNumberOrNull(attributes.personalListOrder) &&
      nullableDate(attributes.plannedEndAt) &&
      finiteNumberOrNull(attributes.plannedMinutes) &&
      nullableDate(attributes.plannedStartAt) &&
      nullableId(attributes.projectId) &&
      nullableId(attributes.serviceId) &&
      stringArray(attributes.subscriberIds) &&
      Number.isSafeInteger(attributes.subtasksCount) &&
      (attributes.subtasksCount as number) >= 0 &&
      Array.isArray(attributes.subtasks) &&
      attributes.subtasks.every(
        (subtask) =>
          hasExactKeys(subtask, ['completed', 'id', 'name', 'order']) &&
          typeof subtask.completed === 'boolean' &&
          typeof subtask.id === 'string' &&
          typeof subtask.name === 'string' &&
          typeof subtask.order === 'number' &&
          Number.isFinite(subtask.order),
      ) &&
      stringArray(attributes.tagIds) &&
      typeof attributes.trackingActive === 'boolean' &&
      nullableDate(attributes.updatedAt)
    )
  })

export const projectValidator = (value: unknown): value is Project =>
  exactResource(value, 'project', anyStringPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'actualEndAt',
        'actualStartAt',
        'additionalContactIds',
        'archived',
        'color',
        'completed',
        'contactId',
        'createdAt',
        'createdById',
        'description',
        'developerRevision',
        'developerUpdatedAt',
        'dueAt',
        'duplicateOfProjectId',
        'earliestEndAt',
        'earliestStartAt',
        'individualId',
        'listId',
        'managerId',
        'name',
        'order',
        'plannedEndAt',
        'plannedStartAt',
        'schedulingOrder',
        'showInScheduling',
        'subscriberIds',
        'tasksCompleted',
        'tasksOpen',
        'tasksTotal',
        'lastActivityAt',
        'latestEndAt',
        'latestStartAt',
        'updatedAt',
      ])
    ) {
      return false
    }
    return (
      nullableDate(attributes.actualEndAt) &&
      nullableDate(attributes.actualStartAt) &&
      stringArray(attributes.additionalContactIds) &&
      typeof attributes.archived === 'boolean' &&
      nullableString(attributes.color) &&
      typeof attributes.completed === 'boolean' &&
      nullableId(attributes.contactId) &&
      nullableDate(attributes.createdAt) &&
      nullableId(attributes.createdById) &&
      typeof attributes.description === 'string' &&
      typeof attributes.developerRevision === 'string' &&
      developerRevisionPattern.test(attributes.developerRevision) &&
      canonicalDate(attributes.developerUpdatedAt) &&
      nullableDate(attributes.dueAt) &&
      nullableId(attributes.duplicateOfProjectId) &&
      nullableDate(attributes.earliestEndAt) &&
      nullableDate(attributes.earliestStartAt) &&
      nullableId(attributes.individualId) &&
      nullableId(attributes.listId) &&
      nullableId(attributes.managerId) &&
      typeof attributes.name === 'string' &&
      finiteNumberOrNull(attributes.order) &&
      nullableDate(attributes.plannedEndAt) &&
      nullableDate(attributes.plannedStartAt) &&
      finiteNumberOrNull(attributes.schedulingOrder) &&
      typeof attributes.showInScheduling === 'boolean' &&
      stringArray(attributes.subscriberIds) &&
      Number.isSafeInteger(attributes.tasksCompleted) &&
      (attributes.tasksCompleted as number) >= 0 &&
      Number.isSafeInteger(attributes.tasksOpen) &&
      (attributes.tasksOpen as number) >= 0 &&
      Number.isSafeInteger(attributes.tasksTotal) &&
      (attributes.tasksTotal as number) >= 0 &&
      nullableDate(attributes.lastActivityAt) &&
      nullableDate(attributes.latestEndAt) &&
      nullableDate(attributes.latestStartAt) &&
      nullableDate(attributes.updatedAt)
    )
  })

export const projectSharingValidator = (value: unknown): value is ProjectSharing =>
  exactResource(value, 'projectSharing', anyStringPattern, (attributes) => {
    if (!hasExactKeys(attributes, ['availablePermissions', 'entries', 'revision'])) return false
    if (
      !stringArray(attributes.availablePermissions) ||
      new Set(attributes.availablePermissions).size !== attributes.availablePermissions.length ||
      attributes.availablePermissions.some(
        (permission) => !boundedString(permission, 128, false),
      ) ||
      typeof attributes.revision !== 'string' ||
      !developerRevisionPattern.test(attributes.revision) ||
      !Array.isArray(attributes.entries) ||
      attributes.entries.length > 1000
    ) {
      return false
    }
    const availablePermissions = attributes.availablePermissions
    return attributes.entries.every(
      (entry) =>
        hasExactKeys(entry, ['permissions', 'userId', 'workspaceId']) &&
        boundedString(entry.workspaceId, 128, false) &&
        (entry.userId === null || boundedString(entry.userId, 128, false)) &&
        stringArray(entry.permissions) &&
        new Set(entry.permissions).size === entry.permissions.length &&
        entry.permissions.every(
          (permission) =>
            boundedString(permission, 128, false) && availablePermissions.includes(permission),
        ),
    )
  })

export const projectTemplateValidator = (value: unknown): value is ProjectTemplate =>
  exactResource(value, 'projectTemplate', templateIdPattern, (attributes) => {
    if (
      !hasExactKeys(attributes, [
        'archived',
        'color',
        'createdAt',
        'description',
        'developerRevision',
        'developerUpdatedAt',
        'originProjectId',
        'snapshotVersion',
        'stats',
        'title',
        'updatedAt',
      ])
    ) {
      return false
    }
    const stats = attributes.stats
    return (
      typeof attributes.archived === 'boolean' &&
      typeof attributes.color === 'string' &&
      /^#[0-9a-f]{6}$/.test(attributes.color) &&
      nullableDate(attributes.createdAt) &&
      boundedString(attributes.description, 50_000) &&
      typeof attributes.developerRevision === 'string' &&
      developerRevisionPattern.test(attributes.developerRevision) &&
      canonicalDate(attributes.developerUpdatedAt) &&
      (attributes.originProjectId === null ||
        (typeof attributes.originProjectId === 'string' &&
          boundedString(attributes.originProjectId, 128))) &&
      (attributes.snapshotVersion === null || attributes.snapshotVersion === 1) &&
      (stats === null ||
        (hasExactKeys(stats, ['listCount', 'taskCount']) &&
          Number.isSafeInteger(stats.listCount) &&
          Number(stats.listCount) >= 0 &&
          Number(stats.listCount) <= 100 &&
          Number.isSafeInteger(stats.taskCount) &&
          Number(stats.taskCount) >= 0 &&
          Number(stats.taskCount) <= 5000)) &&
      boundedString(attributes.title, 500, false) &&
      nullableDate(attributes.updatedAt)
    )
  })

function operationError(value: unknown, maximumMessageLength: number) {
  return (
    hasExactKeys(value, ['code', 'message']) &&
    boundedString(value.code, 128, false) &&
    boundedString(value.message, maximumMessageLength, false)
  )
}

function terminalStateIsConsistent(attributes: RecordValue, maximumErrorLength: number) {
  const hasError = Object.hasOwn(attributes, 'error')
  const hasFinishedAt = Object.hasOwn(attributes, 'finishedAt')
  const hasStartedAt = Object.hasOwn(attributes, 'startedAt')
  if (hasStartedAt && !canonicalDate(attributes.startedAt)) return false
  if (attributes.state === 'failed') {
    return (
      hasError &&
      operationError(attributes.error, maximumErrorLength) &&
      hasFinishedAt &&
      canonicalDate(attributes.finishedAt)
    )
  }
  if (attributes.state === 'succeeded') {
    return !hasError && hasFinishedAt && canonicalDate(attributes.finishedAt)
  }
  return (
    (attributes.state === 'pending' || attributes.state === 'running') &&
    !hasError &&
    !hasFinishedAt
  )
}

function lifecycleCheckpoints(value: unknown) {
  if (
    !hasAllowedKeys(
      value,
      ['assets', 'automations', 'finalSweep', 'project', 'sweepAfterId', 'tasks', 'tasksAfterId'],
      [],
    )
  ) {
    return false
  }
  return Object.entries(value).every(([key, item]) =>
    key.endsWith('AfterId') ? boundedString(item, 128, false) : typeof item === 'boolean',
  )
}

export const projectLifecycleOperationValidator = (
  value: unknown,
): value is ProjectLifecycleOperation => {
  if (
    !hasExactKeys(value, ['attributes', 'id', 'type']) ||
    value.type !== 'projectLifecycleOperation' ||
    typeof value.id !== 'string' ||
    !boundedString(value.id, 128, false) ||
    !hasAllowedKeys(
      value.attributes,
      [
        'action',
        'attempts',
        'checkpoints',
        'createdAt',
        'error',
        'finishedAt',
        'noOp',
        'projectId',
        'resultRevision',
        'sourceRevision',
        'startedAt',
        'state',
        'updatedAt',
      ],
      [
        'action',
        'attempts',
        'checkpoints',
        'createdAt',
        'noOp',
        'projectId',
        'resultRevision',
        'sourceRevision',
        'state',
        'updatedAt',
      ],
    )
  ) {
    return false
  }
  const attributes = value.attributes
  return (
    ['archive', 'complete', 'reopen', 'restore'].includes(String(attributes.action)) &&
    Number.isSafeInteger(attributes.attempts) &&
    Number(attributes.attempts) >= 0 &&
    lifecycleCheckpoints(attributes.checkpoints) &&
    canonicalDate(attributes.createdAt) &&
    typeof attributes.noOp === 'boolean' &&
    typeof attributes.projectId === 'string' &&
    boundedString(attributes.projectId, 128, false) &&
    (attributes.resultRevision === null ||
      (typeof attributes.resultRevision === 'string' &&
        developerRevisionPattern.test(attributes.resultRevision))) &&
    typeof attributes.sourceRevision === 'string' &&
    developerRevisionPattern.test(attributes.sourceRevision) &&
    ((attributes.state === 'succeeded' && typeof attributes.resultRevision === 'string') ||
      (attributes.state !== 'succeeded' && attributes.resultRevision === null)) &&
    canonicalDate(attributes.updatedAt) &&
    terminalStateIsConsistent(attributes, 5000)
  )
}

export const projectTemplateInstantiationValidator = (
  value: unknown,
): value is ProjectTemplateInstantiation => {
  if (
    !hasExactKeys(value, ['attributes', 'id', 'type']) ||
    value.type !== 'projectTemplateInstantiation' ||
    typeof value.id !== 'string' ||
    !templateIdPattern.test(value.id) ||
    !hasAllowedKeys(
      value.attributes,
      [
        'createdAt',
        'error',
        'finishedAt',
        'progress',
        'projectId',
        'resultRevision',
        'sourceRevision',
        'state',
        'templateId',
        'updatedAt',
      ],
      [
        'createdAt',
        'progress',
        'projectId',
        'resultRevision',
        'sourceRevision',
        'state',
        'templateId',
        'updatedAt',
      ],
    )
  ) {
    return false
  }
  const attributes = value.attributes
  const progress = attributes.progress
  return (
    canonicalDate(attributes.createdAt) &&
    hasExactKeys(progress, ['listsCompleted', 'listsTotal', 'tasksCompleted', 'tasksTotal']) &&
    Number.isSafeInteger(progress.listsCompleted) &&
    Number(progress.listsCompleted) >= 0 &&
    Number(progress.listsCompleted) <= Number(progress.listsTotal) &&
    Number.isSafeInteger(progress.listsTotal) &&
    Number(progress.listsTotal) >= 0 &&
    Number(progress.listsTotal) <= 100 &&
    Number.isSafeInteger(progress.tasksCompleted) &&
    Number(progress.tasksCompleted) >= 0 &&
    Number(progress.tasksCompleted) <= Number(progress.tasksTotal) &&
    Number.isSafeInteger(progress.tasksTotal) &&
    Number(progress.tasksTotal) >= 0 &&
    Number(progress.tasksTotal) <= 5000 &&
    typeof attributes.projectId === 'string' &&
    templateIdPattern.test(attributes.projectId) &&
    (attributes.resultRevision === null ||
      (typeof attributes.resultRevision === 'string' &&
        developerRevisionPattern.test(attributes.resultRevision))) &&
    typeof attributes.sourceRevision === 'string' &&
    developerRevisionPattern.test(attributes.sourceRevision) &&
    ((attributes.state === 'succeeded' && typeof attributes.resultRevision === 'string') ||
      (attributes.state !== 'succeeded' && attributes.resultRevision === null)) &&
    typeof attributes.templateId === 'string' &&
    templateIdPattern.test(attributes.templateId) &&
    canonicalDate(attributes.updatedAt) &&
    terminalStateIsConsistent(attributes, 500)
  )
}

export function assertProjectLifecycleOperationContinuity(
  operation: ProjectLifecycleOperation,
  expected: ProjectLifecycleOperation,
  label: string,
) {
  if (operation.id !== expected.id) invalidResponse(label, 'operation id changed while polling')
  if (operation.attributes.action !== expected.attributes.action) {
    invalidResponse(label, 'operation action changed while polling')
  }
  if (operation.attributes.projectId !== expected.attributes.projectId) {
    invalidResponse(label, 'project id changed while polling')
  }
}

export function assertProjectTemplateInstantiationContinuity(
  operation: ProjectTemplateInstantiation,
  expected: ProjectTemplateInstantiation,
  label: string,
) {
  if (operation.id !== expected.id) invalidResponse(label, 'operation id changed while polling')
  if (operation.attributes.templateId !== expected.attributes.templateId) {
    invalidResponse(label, 'template id changed while polling')
  }
  if (operation.attributes.projectId !== expected.attributes.projectId) {
    invalidResponse(label, 'project id changed while polling')
  }
}

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const cleanupStates = new Set(['complete', 'failed', 'pending', 'running'])
const resourceStates = new Set(['cleanup_failed', 'cleanup_pending', 'cleaned'])
const mutationIntentStates = new Set(['pending', 'resolved'])
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const safeRequestValue = /^[\x20-\x7e]{1,1024}$/

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertIdentifier(value, label) {
  if (!safeIdentifier.test(value || '')) {
    throw new Error(`${label} must be a bounded opaque identifier.`)
  }
}

function assertJournal(journal) {
  if (
    journal?.journalContract !== 'teamgrid-developer-platform-cleanup-journal-v1' ||
    journal?.schemaVersion !== 1 ||
    !cleanupStates.has(journal.state) ||
    !Array.isArray(journal.mutationIntents) ||
    journal.mutationIntents.some(
      (intent) =>
        !mutationIntentStates.has(intent.state) ||
        !safeIdentifier.test(intent.operationId || '') ||
        !safeRequestValue.test(intent.idempotencyKey || '') ||
        !isBoundedJson(intent.request) ||
        !isBoundedJson(intent.captures) ||
        !isBoundedJson(intent.cleanup),
    ) ||
    !Array.isArray(journal.resources) ||
    journal.resources.some(
      (resource) =>
        !resourceStates.has(resource.state) ||
        !resource.cleanupRequest ||
        typeof resource.cleanupRequest !== 'object' ||
        Array.isArray(resource.cleanupRequest) ||
        !resource.cleanupRequest.pathParameters ||
        typeof resource.cleanupRequest.pathParameters !== 'object' ||
        Array.isArray(resource.cleanupRequest.pathParameters) ||
        Object.entries(resource.cleanupRequest.pathParameters).some(
          ([key, value]) => !safeIdentifier.test(key) || !safeRequestValue.test(value),
        ) ||
        (resource.cleanupRequest.ifMatch !== undefined &&
          !safeRequestValue.test(resource.cleanupRequest.ifMatch)) ||
        (resource.cleanupRequest.idempotencyKey !== undefined &&
          !safeRequestValue.test(resource.cleanupRequest.idempotencyKey)),
    )
  ) {
    throw new Error('The conformance cleanup journal is malformed.')
  }
}

function isBoundedJson(value) {
  try {
    const serialized = JSON.stringify(value)
    return (
      serialized.length > 0 &&
      serialized.length <= 2 * 1024 * 1024 &&
      !/"authorization"\s*:/i.test(serialized)
    )
  } catch {
    return false
  }
}

export function createCleanupJournal({
  createdAt = new Date().toISOString(),
  fixtureNamespace,
  runId,
}) {
  assertIdentifier(runId, 'runId')
  assertIdentifier(fixtureNamespace, 'fixtureNamespace')
  return {
    createdAt,
    fixtureNamespace,
    journalContract: 'teamgrid-developer-platform-cleanup-journal-v1',
    mutationIntents: [],
    resources: [],
    runId,
    schemaVersion: 1,
    state: 'pending',
    updatedAt: createdAt,
  }
}

export function registerMutationIntent(
  journal,
  {
    captures,
    cleanup,
    idempotencyKey,
    operationId,
    registeredAt = new Date().toISOString(),
    request,
  },
) {
  assertJournal(journal)
  assertIdentifier(operationId, 'operationId')
  if (!safeRequestValue.test(idempotencyKey || '')) {
    throw new Error('idempotencyKey must be bounded printable text.')
  }
  for (const [value, label] of [
    [captures, 'captures'],
    [cleanup, 'cleanup'],
    [request, 'request'],
  ]) {
    if (!isBoundedJson(value)) throw new Error(`${label} must be bounded JSON.`)
  }
  if (
    journal.mutationIntents.some(
      (intent) => intent.operationId === operationId && intent.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error('The mutation intent is already registered.')
  }
  return {
    ...journal,
    mutationIntents: [
      ...journal.mutationIntents,
      {
        captures,
        cleanup,
        idempotencyKey,
        operationId,
        registeredAt,
        request,
        state: 'pending',
      },
    ],
    state: 'running',
    updatedAt: registeredAt,
  }
}

export function resolveMutationIntent(
  journal,
  { idempotencyKey, operationId, resolvedAt = new Date().toISOString() },
) {
  assertJournal(journal)
  const index = journal.mutationIntents.findIndex(
    (intent) => intent.operationId === operationId && intent.idempotencyKey === idempotencyKey,
  )
  if (index < 0) throw new Error('The mutation intent is not registered.')
  return {
    ...journal,
    mutationIntents: journal.mutationIntents.map((intent, intentIndex) =>
      intentIndex === index ? { ...intent, resolvedAt, state: 'resolved' } : intent,
    ),
    updatedAt: resolvedAt,
  }
}

export function pendingMutationIntents(journal) {
  assertJournal(journal)
  return journal.mutationIntents.filter((intent) => intent.state === 'pending')
}

export function registerCleanupResource(
  journal,
  {
    cleanupOperationId,
    cleanupRequest,
    createdByOperationId,
    registeredAt = new Date().toISOString(),
    resourceId,
    resourceType,
  },
) {
  assertJournal(journal)
  for (const [identifier, label] of [
    [cleanupOperationId, 'cleanupOperationId'],
    [createdByOperationId, 'createdByOperationId'],
    [resourceId, 'resourceId'],
    [resourceType, 'resourceType'],
  ]) {
    assertIdentifier(identifier, label)
  }
  const normalizedCleanupRequest = {
    ...(cleanupRequest?.idempotencyKey
      ? { idempotencyKey: String(cleanupRequest.idempotencyKey) }
      : {}),
    ...(cleanupRequest?.ifMatch ? { ifMatch: String(cleanupRequest.ifMatch) } : {}),
    pathParameters: Object.fromEntries(
      Object.entries(cleanupRequest?.pathParameters || {}).map(([key, value]) => [
        String(key),
        String(value),
      ]),
    ),
  }
  for (const [key, value] of Object.entries(normalizedCleanupRequest.pathParameters)) {
    assertIdentifier(key, 'cleanup path parameter')
    if (!safeRequestValue.test(value)) {
      throw new Error('cleanup path parameter value must be bounded printable text.')
    }
  }
  for (const [key, value] of Object.entries(normalizedCleanupRequest)) {
    if (key !== 'pathParameters' && !safeRequestValue.test(value)) {
      throw new Error(`${key} must be bounded printable text.`)
    }
  }
  if (
    journal.resources.some(
      (resource) => resource.resourceId === resourceId && resource.resourceType === resourceType,
    )
  ) {
    throw new Error('The cleanup resource is already registered.')
  }

  return {
    ...journal,
    resources: [
      ...journal.resources,
      {
        attempts: 0,
        cleanupOperationId,
        cleanupRequest: normalizedCleanupRequest,
        createdByOperationId,
        lastErrorCode: null,
        registeredAt,
        resourceId,
        resourceType,
        state: 'cleanup_pending',
      },
    ],
    state: 'running',
    updatedAt: registeredAt,
  }
}

export function recordCleanupResult(
  journal,
  { errorCode, finishedAt = new Date().toISOString(), resourceId, resourceType, succeeded },
) {
  assertJournal(journal)
  const index = journal.resources.findIndex(
    (resource) => resource.resourceId === resourceId && resource.resourceType === resourceType,
  )
  if (index < 0) throw new Error('The cleanup resource is not registered.')
  if (errorCode) assertIdentifier(errorCode, 'errorCode')

  const resources = journal.resources.map((resource, resourceIndex) =>
    resourceIndex === index
      ? {
          ...resource,
          attempts: resource.attempts + 1,
          lastErrorCode: succeeded ? null : errorCode || 'cleanup_failed',
          state: succeeded ? 'cleaned' : 'cleanup_failed',
        }
      : resource,
  )
  const complete = resources.every((resource) => resource.state === 'cleaned')
  const failed = resources.some((resource) => resource.state === 'cleanup_failed')
  return {
    ...journal,
    resources,
    state: complete ? 'complete' : failed ? 'failed' : 'running',
    updatedAt: finishedAt,
  }
}

export function cleanupResourcesInReverseOrder(journal) {
  assertJournal(journal)
  return [...journal.resources].reverse().filter((resource) => resource.state !== 'cleaned')
}

export function assertCleanupComplete(journal) {
  assertJournal(journal)
  if (
    journal.state !== 'complete' ||
    journal.mutationIntents.some((intent) => intent.state !== 'resolved') ||
    journal.resources.some((resource) => resource.state !== 'cleaned')
  ) {
    throw new Error('Conformance cleanup is incomplete.')
  }
  return true
}

export function finalizeCleanupJournal(journal, { completedAt = new Date().toISOString() } = {}) {
  assertJournal(journal)
  if (journal.resources.some((resource) => resource.state !== 'cleaned')) {
    throw new Error('Conformance cleanup cannot finish with unreconciled resources.')
  }
  if (journal.mutationIntents.some((intent) => intent.state !== 'resolved')) {
    throw new Error('Conformance cleanup cannot finish with unresolved mutation intents.')
  }
  return {
    ...journal,
    state: 'complete',
    updatedAt: completedAt,
  }
}

export function writeCleanupJournal(path, journal, { secrets = [] } = {}) {
  assertJournal(journal)
  const payload = `${JSON.stringify(journal, null, 2)}\n`
  for (const secret of secrets) {
    if (secret && payload.includes(secret)) {
      throw new Error('The cleanup journal contains a runtime credential.')
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
  return sha256(payload)
}

export function readCleanupJournal(path) {
  const journal = JSON.parse(readFileSync(path, 'utf8'))
  assertJournal(journal)
  return journal
}

export function assertJournalPathReady(path) {
  if (!existsSync(path)) return true
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error('The cleanup journal path must not be a symbolic link.')
  }
  const existing = readCleanupJournal(path)
  if (existing.state !== 'complete') {
    throw new Error('An unfinished conformance cleanup journal already exists.')
  }
  throw new Error('The cleanup journal path already contains a completed run.')
}

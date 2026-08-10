import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertCleanupComplete,
  assertJournalPathReady,
  cleanupResourcesInReverseOrder,
  createCleanupJournal,
  finalizeCleanupJournal,
  pendingMutationIntents,
  readCleanupJournal,
  recordCleanupResult,
  registerCleanupResource,
  registerMutationIntent,
  resolveMutationIntent,
  writeCleanupJournal,
} from './cleanup-journal.mjs'

function journal() {
  return createCleanupJournal({
    createdAt: '2026-07-30T12:00:00.000Z',
    fixtureNamespace: 'codex-conformance-acme-01',
    runId: 'run-1',
  })
}
const taskIdTemplate = `\${taskId}`

describe('crash-safe mutation cleanup journal', () => {
  it('registers every created resource immediately and cleans up in reverse order', () => {
    const withProject = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveProject',
      cleanupRequest: { pathParameters: { id: 'project-1' } },
      createdByOperationId: 'createProject',
      registeredAt: '2026-07-30T12:00:01.000Z',
      resourceId: 'project-1',
      resourceType: 'project',
    })
    const withTask = registerCleanupResource(withProject, {
      cleanupOperationId: 'archiveTask',
      cleanupRequest: {
        ifMatch: '"tsk1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        pathParameters: { id: 'task-1' },
      },
      createdByOperationId: 'createTask',
      registeredAt: '2026-07-30T12:00:02.000Z',
      resourceId: 'task-1',
      resourceType: 'task',
    })

    expect(cleanupResourcesInReverseOrder(withTask).map((resource) => resource.resourceId)).toEqual(
      ['task-1', 'project-1'],
    )
    expect(() =>
      registerCleanupResource(withTask, {
        cleanupOperationId: 'archiveTask',
        cleanupRequest: { pathParameters: { id: 'task-1' } },
        createdByOperationId: 'createTask',
        resourceId: 'task-1',
        resourceType: 'task',
      }),
    ).toThrow('already registered')
  })

  it('cannot report success until every resource is reconciled', () => {
    const registered = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
      cleanupRequest: { pathParameters: { id: 'task-1' } },
      createdByOperationId: 'createTask',
      resourceId: 'task-1',
      resourceType: 'task',
    })
    const failed = recordCleanupResult(registered, {
      errorCode: 'http_503',
      resourceId: 'task-1',
      resourceType: 'task',
      succeeded: false,
    })
    const recovered = recordCleanupResult(failed, {
      resourceId: 'task-1',
      resourceType: 'task',
      succeeded: true,
    })

    expect(failed).toMatchObject({
      resources: [{ attempts: 1, lastErrorCode: 'http_503', state: 'cleanup_failed' }],
      state: 'failed',
    })
    expect(() => assertCleanupComplete(failed)).toThrow('incomplete')
    expect(assertCleanupComplete(recovered)).toBe(true)
  })

  it('persists idempotent mutation intent before creation and requires reconciliation', () => {
    const pending = registerMutationIntent(journal(), {
      captures: { taskId: { jsonPointer: '/data/id' } },
      cleanup: {
        operationId: 'archiveTask',
        pathParameters: { id: taskIdTemplate },
        resourceId: taskIdTemplate,
        resourceType: 'task',
      },
      idempotencyKey: 'fixture-task-1',
      operationId: 'createTask',
      request: {
        body: { name: 'codex-conformance-acme-01' },
        headers: { 'idempotency-key': 'fixture-task-1' },
        pathParameters: {},
      },
    })

    expect(pendingMutationIntents(pending)).toHaveLength(1)
    expect(() => finalizeCleanupJournal(pending)).toThrow('unresolved mutation intents')
    const resolved = resolveMutationIntent(pending, {
      idempotencyKey: 'fixture-task-1',
      operationId: 'createTask',
    })
    expect(pendingMutationIntents(resolved)).toEqual([])
    expect(finalizeCleanupJournal(resolved)).toMatchObject({ state: 'complete' })
  })

  it('can finish a run that proved every mutation was rejected before creating a resource', () => {
    const completed = finalizeCleanupJournal(journal(), {
      completedAt: '2026-07-30T12:00:03.000Z',
    })

    expect(completed).toMatchObject({
      resources: [],
      state: 'complete',
      updatedAt: '2026-07-30T12:00:03.000Z',
    })
    expect(assertCleanupComplete(completed)).toBe(true)
  })

  it('refuses to finish while a registered resource still needs cleanup', () => {
    const pending = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
      cleanupRequest: { pathParameters: { id: 'task-1' } },
      createdByOperationId: 'createTask',
      resourceId: 'task-1',
      resourceType: 'task',
    })

    expect(() => finalizeCleanupJournal(pending)).toThrow('unreconciled')
  })

  it('persists only opaque cleanup metadata with restrictive permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-cleanup-'))
    const path = join(directory, 'cleanup.json')
    const registered = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
      cleanupRequest: { pathParameters: { id: 'task-1' } },
      createdByOperationId: 'createTask',
      resourceId: 'task-1',
      resourceType: 'task',
    })
    const complete = recordCleanupResult(registered, {
      resourceId: 'task-1',
      resourceType: 'task',
      succeeded: true,
    })
    const digest = writeCleanupJournal(path, complete, {
      secrets: ['production-secret'],
    })

    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(readCleanupJournal(path)).toEqual(complete)
    expect(readFileSync(path, 'utf8')).not.toContain('production-secret')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => assertJournalPathReady(path)).toThrow('completed run')
  })

  it('refuses to overwrite an unfinished journal after a crash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-cleanup-'))
    const path = join(directory, 'cleanup.json')
    const pending = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
      cleanupRequest: { pathParameters: { id: 'task-1' } },
      createdByOperationId: 'createTask',
      resourceId: 'task-1',
      resourceType: 'task',
    })
    writeCleanupJournal(path, pending)

    expect(() => assertJournalPathReady(path)).toThrow('unfinished')
  })
})

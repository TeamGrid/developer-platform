import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertCleanupComplete,
  assertJournalPathReady,
  cleanupResourcesInReverseOrder,
  createCleanupJournal,
  readCleanupJournal,
  recordCleanupResult,
  registerCleanupResource,
  writeCleanupJournal,
} from './cleanup-journal.mjs'

function journal() {
  return createCleanupJournal({
    createdAt: '2026-07-30T12:00:00.000Z',
    fixtureNamespace: 'codex-conformance-acme-01',
    runId: 'run-1',
  })
}

describe('crash-safe mutation cleanup journal', () => {
  it('registers every created resource immediately and cleans up in reverse order', () => {
    const withProject = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveProject',
      createdByOperationId: 'createProject',
      registeredAt: '2026-07-30T12:00:01.000Z',
      resourceId: 'project-1',
      resourceType: 'project',
    })
    const withTask = registerCleanupResource(withProject, {
      cleanupOperationId: 'archiveTask',
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
        createdByOperationId: 'createTask',
        resourceId: 'task-1',
        resourceType: 'task',
      }),
    ).toThrow('already registered')
  })

  it('cannot report success until every resource is reconciled', () => {
    const registered = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
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

  it('persists only opaque cleanup metadata with restrictive permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-cleanup-'))
    const path = join(directory, 'cleanup.json')
    const registered = registerCleanupResource(journal(), {
      cleanupOperationId: 'archiveTask',
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
      createdByOperationId: 'createTask',
      resourceId: 'task-1',
      resourceType: 'task',
    })
    writeCleanupJournal(path, pending)

    expect(() => assertJournalPathReady(path)).toThrow('unfinished')
  })
})

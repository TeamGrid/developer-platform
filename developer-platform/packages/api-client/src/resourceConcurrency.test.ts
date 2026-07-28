import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import {
  projectLifecycleOperationValidator,
  projectTemplateInstantiationValidator,
  taskValidator,
} from './resourceConcurrency.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const now = '2026-07-19T10:00:00.000Z'
const revision = 'a'.repeat(64)

function task() {
  return {
    attributes: {
      archived: false,
      archivedAt: null,
      assigneeId: null,
      billable: null,
      completed: false,
      completedAt: null,
      completedById: null,
      commentsCount: 0,
      contactId: null,
      createdAt: now,
      createdById: null,
      description: '',
      developerRevision: revision,
      developerUpdatedAt: now,
      duplicateOfTaskId: null,
      dueAt: null,
      filesCount: 0,
      groupId: null,
      listId: null,
      listOrder: null,
      name: 'Task',
      order: null,
      personalListId: null,
      personalListOrder: null,
      plannedEndAt: null,
      plannedMinutes: null,
      plannedStartAt: null,
      projectId: null,
      serviceId: null,
      subscriberIds: [],
      subtasksCount: 0,
      subtasks: [],
      tagIds: [],
      trackingActive: false,
      updatedAt: now,
    },
    id: 'task-1',
    type: 'task',
  }
}

function pendingLifecycleOperation() {
  return {
    attributes: {
      action: 'complete',
      attempts: 0,
      checkpoints: {},
      createdAt: now,
      noOp: false,
      projectId: 'project-1',
      resultRevision: null,
      sourceRevision: revision,
      state: 'pending',
      updatedAt: now,
    },
    id: 'operation-1',
    type: 'projectLifecycleOperation',
  }
}

function pendingInstantiation() {
  return {
    attributes: {
      createdAt: now,
      progress: { listsCompleted: 0, listsTotal: 1, tasksCompleted: 0, tasksTotal: 1 },
      projectId: 'project-1',
      resultRevision: null,
      sourceRevision: revision,
      state: 'pending',
      templateId: 'template-1',
      updatedAt: now,
    },
    id: 'instantiation-1',
    type: 'projectTemplateInstantiation',
  }
}

describe('core resource runtime contract', () => {
  it('requires the stable task concurrency fields', () => {
    const current = task()
    expect(taskValidator(current)).toBe(true)
    expect(
      taskValidator({
        ...current,
        attributes: { ...current.attributes, developerRevision: 'invalid' },
      }),
    ).toBe(false)
  })

  it('canonicalizes and sends the required task If-Match precondition', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH')
      expect(new Headers(init?.headers).get('if-match')).toBe(`"tsk1-${revision}"`)
      return new Response(JSON.stringify({ data: task(), meta: { requestId: 'request-1' } }), {
        headers: {
          'cache-control': 'private, no-store, no-transform',
          'content-type': 'application/json',
          etag: `"tsk1-${revision}"`,
        },
        status: 200,
      })
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.tasks.update('task-1', { name: 'Changed' }, { ifMatch: `tsk1-${revision}` }),
    ).resolves.toMatchObject({ data: task() })
    expect(fetch).toHaveBeenCalledOnce()
    await expect(
      client.tasks.update('task-1', { name: 'Changed again' }, { ifMatch: 'legacy' as never }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('binds stable task workflows to revision and idempotency preconditions', async () => {
    const calls: Array<{ body: unknown; headers: Headers; method: string; path: string }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const headers = new Headers(init?.headers)
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers,
        method: String(init?.method),
        path,
      })
      const duplicate = path.endsWith('/duplicate')
      return new Response(
        JSON.stringify({ data: task(), meta: { requestId: 'request-workflow' } }),
        {
          headers: {
            'cache-control': 'private, no-store, no-transform',
            'content-type': 'application/json',
            etag: `"tsk1-${revision}"`,
            ...(duplicate ? { 'idempotency-replayed': 'false' } : {}),
          },
          status: duplicate ? 201 : 200,
        },
      )
    })
    const client = new TeamGridClient({ fetch, token })
    await client.tasks.duplicate(
      'task-1',
      { copyChecklist: true, name: 'Task copy' },
      { idempotencyKey: 'duplicate-task-1', ifMatch: `tsk1-${revision}` },
    )
    await client.tasks.move(
      'task-1',
      { axis: 'projectList', listId: 'list-2', projectId: 'project-2' },
      { ifMatch: `tsk1-${revision}` },
    )
    await client.tasks.replaceSubtasks(
      'task-1',
      { subtasks: [{ completed: false, title: 'Review' }] },
      { ifMatch: `tsk1-${revision}` },
    )

    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/v1/tasks/task-1/duplicate' },
      { method: 'POST', path: '/v1/tasks/task-1/move' },
      { method: 'PUT', path: '/v1/tasks/task-1/subtasks' },
    ])
    for (const call of calls) {
      expect(call.headers.get('if-match')).toBe(`"tsk1-${revision}"`)
    }
    expect(calls[0]?.headers.get('idempotency-key')).toBe('duplicate-task-1')
    expect(calls.map((call) => call.body)).toEqual([
      { copyChecklist: true, name: 'Task copy' },
      { axis: 'projectList', listId: 'list-2', projectId: 'project-2' },
      { subtasks: [{ completed: false, title: 'Review' }] },
    ])
  })

  it('enforces lifecycle terminal-state invariants without revision fields', () => {
    const pending = pendingLifecycleOperation()
    expect(projectLifecycleOperationValidator(pending)).toBe(true)
    expect(
      projectLifecycleOperationValidator({
        ...pending,
        attributes: { ...pending.attributes, finishedAt: now },
      }),
    ).toBe(false)
    expect(
      projectLifecycleOperationValidator({
        ...pending,
        attributes: {
          ...pending.attributes,
          state: 'succeeded',
          resultRevision: revision,
        },
      }),
    ).toBe(false)
    expect(
      projectLifecycleOperationValidator({
        ...pending,
        attributes: {
          ...pending.attributes,
          error: { code: 'failed', message: 'Failed' },
          finishedAt: now,
          state: 'failed',
        },
      }),
    ).toBe(true)
  })

  it('enforces template-instantiation progress and terminal-state invariants', () => {
    const pending = pendingInstantiation()
    expect(projectTemplateInstantiationValidator(pending)).toBe(true)
    expect(
      projectTemplateInstantiationValidator({
        ...pending,
        attributes: {
          ...pending.attributes,
          progress: { listsCompleted: 2, listsTotal: 1, tasksCompleted: 0, tasksTotal: 1 },
        },
      }),
    ).toBe(false)
    expect(
      projectTemplateInstantiationValidator({
        ...pending,
        attributes: {
          ...pending.attributes,
          finishedAt: now,
          resultRevision: revision,
          state: 'succeeded',
        },
      }),
    ).toBe(true)
  })
})

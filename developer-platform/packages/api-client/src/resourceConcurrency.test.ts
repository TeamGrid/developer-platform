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

function task() {
  return {
    attributes: {
      archived: false,
      assigneeId: null,
      billable: null,
      completed: false,
      createdAt: now,
      description: '',
      dueAt: null,
      groupId: null,
      listId: null,
      name: 'Task',
      plannedEndAt: null,
      plannedMinutes: null,
      plannedStartAt: null,
      projectId: null,
      serviceId: null,
      subscriberIds: [],
      tagIds: [],
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
      state: 'pending',
      templateId: 'template-1',
      updatedAt: now,
    },
    id: 'instantiation-1',
    type: 'projectTemplateInstantiation',
  }
}

describe('core resource runtime contract', () => {
  it('accepts the static beta.2 task shape and rejects retired CAS fields', () => {
    const current = task()
    expect(taskValidator(current)).toBe(true)
    expect(
      taskValidator({
        ...current,
        attributes: { ...current.attributes, developerRevision: 'a'.repeat(64) },
      }),
    ).toBe(false)
  })

  it('sends core mutations without an If-Match precondition', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH')
      expect(new Headers(init?.headers).has('if-match')).toBe(false)
      return new Response(JSON.stringify({ data: task(), meta: { requestId: 'request-1' } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(client.tasks.update('task-1', { name: 'Changed' })).resolves.toMatchObject({
      data: task(),
    })
    expect(fetch).toHaveBeenCalledOnce()
    await expect(
      client.tasks.update('task-1', { name: 'Changed again' }, { ifMatch: 'legacy' } as never),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(fetch).toHaveBeenCalledOnce()
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
          state: 'succeeded',
        },
      }),
    ).toBe(true)
  })
})

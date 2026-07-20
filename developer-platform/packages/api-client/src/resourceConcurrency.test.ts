import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import {
  canonicalProjectStrongETag,
  canonicalProjectTemplateStrongETag,
  canonicalTaskStrongETag,
  projectLifecycleOperationValidator,
  projectTemplateInstantiationValidator,
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
      developerRevision: 'a'.repeat(64),
      developerUpdatedAt: now,
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
      resultRevision: null,
      sourceRevision: 'a'.repeat(64),
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
      sourceRevision: 'b'.repeat(64),
      state: 'pending',
      templateId: 'template-1',
      updatedAt: now,
    },
    id: 'instantiation-1',
    type: 'projectTemplateInstantiation',
  }
}

describe('resource concurrency runtime contract', () => {
  it('canonicalizes only exact raw revisions or resource-specific strong ETags', () => {
    const revision = 'a'.repeat(64)
    expect(canonicalTaskStrongETag(revision)).toBe(`"tsk1-${revision}"`)
    expect(canonicalProjectStrongETag(`"prj1-${revision}"`)).toBe(`"prj1-${revision}"`)
    expect(canonicalProjectTemplateStrongETag(revision)).toBe(`"tpl1-${revision}"`)

    for (const invalid of [
      '*',
      ` ${revision}`,
      `W/"tsk1-${revision}"`,
      `"prj1-${revision}"`,
      revision.toUpperCase(),
      `${revision},${revision}`,
    ]) {
      expect(() => canonicalTaskStrongETag(invalid)).toThrowError(
        expect.objectContaining({ code: 'invalid_arguments' }),
      )
    }
  })

  it('rejects a missing runtime If-Match before making a network request', async () => {
    const fetch = vi.fn()
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.tasks.update('task-1', { name: 'Changed' }, undefined as never),
    ).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when a resource body revision and response ETag differ', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ data: task(), meta: { requestId: 'request-1' } }), {
            headers: {
              'content-type': 'application/json',
              etag: `"tsk1-${'b'.repeat(64)}"`,
            },
            status: 200,
          }),
      ),
      token,
    })
    await expect(client.tasks.get('task-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('enforces lifecycle source/result revision and terminal-state invariants', () => {
    const pending = pendingLifecycleOperation()
    expect(projectLifecycleOperationValidator(pending)).toBe(true)
    expect(
      projectLifecycleOperationValidator({
        ...pending,
        attributes: { ...pending.attributes, resultRevision: 'b'.repeat(64) },
      }),
    ).toBe(false)
    expect(
      projectLifecycleOperationValidator({
        ...pending,
        attributes: {
          ...pending.attributes,
          resultRevision: 'b'.repeat(64),
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

  it('enforces template-instantiation progress and terminal revision invariants', () => {
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
          resultRevision: 'c'.repeat(64),
          state: 'succeeded',
        },
      }),
    ).toBe(true)
  })
})

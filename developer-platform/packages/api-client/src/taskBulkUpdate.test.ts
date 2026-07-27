import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_de_de-nbg-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const revision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)
const timestamp = '2026-07-27T15:00:00.000Z'

function task(id: string) {
  return {
    attributes: {
      archived: false,
      archivedAt: null,
      assigneeId: null,
      billable: null,
      commentsCount: 0,
      completed: false,
      completedAt: null,
      completedById: null,
      contactId: null,
      createdAt: timestamp,
      createdById: null,
      description: '',
      developerRevision: nextRevision,
      developerUpdatedAt: timestamp,
      dueAt: null,
      duplicateOfTaskId: null,
      filesCount: 0,
      groupId: null,
      listId: null,
      listOrder: null,
      name: 'Updated',
      order: null,
      personalListId: null,
      personalListOrder: null,
      plannedEndAt: null,
      plannedMinutes: null,
      plannedStartAt: null,
      projectId: null,
      serviceId: null,
      subscriberIds: [],
      subtasks: [],
      subtasksCount: 0,
      tagIds: [],
      trackingActive: false,
      updatedAt: timestamp,
    },
    id,
    type: 'task',
  }
}

function envelope(secondId = 'task-2') {
  return {
    data: [
      {
        attributes: { error: null, status: 'updated', task: task('task-1') },
        id: 'task-1',
        type: 'taskBulkUpdateResult',
      },
      {
        attributes: {
          error: {
            code: 'precondition_failed',
            detail: 'The task changed after it was read.',
            status: '412',
            title: 'Precondition Failed',
          },
          status: 'conflict',
          task: null,
        },
        id: secondId,
        type: 'taskBulkUpdateResult',
      },
    ],
    meta: {
      requestId: 'request-bulk',
      summary: { conflicts: 1, failed: 0, requested: 2, updated: 1 },
    },
  }
}

const input = {
  items: [
    { data: { name: 'Updated' }, id: 'task-1', revision },
    { data: { dueAt: null }, id: 'task-2', revision },
  ],
}

describe('task bulk-update SDK surface', () => {
  it('preserves ordered independent results and never invents an idempotency retry', async () => {
    const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(request)).pathname).toBe('/v1/tasks/bulk-update')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('idempotency-key')).toBeNull()
      expect(JSON.parse(String(init?.body))).toEqual(input)
      return new Response(JSON.stringify(envelope()), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-bulk' },
        status: 200,
      })
    })
    const client = new TeamGridClient({ fetch, retries: 5, token })

    const result = await client.tasks.bulkUpdate(input)

    expect(result.data.map((item) => [item.id, item.attributes.status])).toEqual([
      ['task-1', 'updated'],
      ['task-2', 'conflict'],
    ])
    expect(result.meta.summary).toEqual({ conflicts: 1, failed: 0, requested: 2, updated: 1 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fails closed on reordered results or inconsistent totals', async () => {
    const responses = [
      envelope('other-task'),
      {
        ...envelope(),
        meta: {
          ...envelope().meta,
          summary: { conflicts: 0, failed: 0, requested: 2, updated: 2 },
        },
      },
    ]
    const fetch = vi.fn(async () => {
      const body = responses.shift()
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    })
    const client = new TeamGridClient({ fetch, retries: 0, token })

    await expect(client.tasks.bulkUpdate(input)).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
    await expect(client.tasks.bulkUpdate(input)).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })
})

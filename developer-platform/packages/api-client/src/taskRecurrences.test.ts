import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import {
  taskRecurrenceEventValidator,
  taskRecurrenceOccurrenceValidator,
  taskRecurrenceOperationValidator,
  taskRecurrencePreviewValidator,
  taskRecurrenceValidator,
  taskRecurrenceVersionValidator,
} from './newDomainValidation.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_de_de-nbg-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const now = '2026-08-18T10:00:00.000Z'
const revision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)
const definitionHash = 'c'.repeat(64)
const occurrenceKey = `occ1-${'d'.repeat(64)}`
const placeholderToken = 'trp1.c2lnbmVkLXByZXZpZXctcHJvb2Y'
const cacheControl = 'private, no-store, no-transform'

function policy() {
  return {
    candidates: {
      nodeId: 'weekdays',
      op: 'calendarRule',
      rule: {
        byWeekDay: [1, 2, 3, 4, 5],
        frequency: 'weekly',
        interval: 1,
        startLocal: '2026-08-18T09:00:00',
      },
    },
    conditions: [],
    engineVersion: 'recurrence-v1',
    limits: { maxOccurrences: null, until: null },
    materialization: {
      catchUp: 'latest',
      lead: { unit: 'day', value: 0 },
      overlap: 'allow',
    },
    schemaVersion: 1,
    timeBasis: {
      disambiguation: 'compatible',
      mode: 'wall-clock',
      timeZone: 'Europe/Berlin',
    },
    transforms: [],
  }
}

function recurrence(overrides: Record<string, unknown> = {}) {
  return {
    attributes: {
      attentionCode: null,
      createdAt: now,
      currentDefinition: {
        costClass: 'low',
        definitionHash,
        engineVersion: 'recurrence-v1',
        id: 'version-1',
        policy: policy(),
        schemaVersion: 1,
        summary: { human: 'Every weekday' },
        template: {
          name: 'Daily review',
          projectId: 'project-1',
          subTasks: [{ order: 10, title: 'Review open items' }],
        },
        version: 1,
      },
      developerUpdatedAt: now,
      name: 'Daily review',
      owner: { id: 'principal-1', kind: 'developerPrincipal' },
      replayed: false,
      resourceContext: { projectId: 'project-1' },
      revision,
      status: 'active',
      updatedAt: now,
      ...overrides,
    },
    id: 'series-1',
    type: 'taskRecurrence',
  }
}

function version() {
  return {
    attributes: {
      changeReason: 'Initial version',
      costClass: 'low',
      createdAt: now,
      createdBy: 'principal-1',
      definitionHash,
      effectiveFromOccurrenceKey: null,
      engineVersion: 'recurrence-v1',
      policy: policy(),
      schemaVersion: 1,
      seriesId: 'series-1',
      summary: { human: 'Every weekday' },
      template: { name: 'Daily review' },
      version: 1,
    },
    id: 'version-1',
    type: 'taskRecurrenceVersion',
  }
}

function occurrence(overrides: Record<string, unknown> = {}) {
  return {
    attributes: {
      attempts: 0,
      cardId: null,
      decision: null,
      definitionVersionId: 'version-1',
      detachedAt: null,
      detachedBy: null,
      detachedCardId: null,
      lastErrorCode: null,
      materializeAt: now,
      materializedAt: null,
      occurrenceKey,
      override: null,
      revision,
      scheduledFor: now,
      scheduledForLocal: '2026-08-18T12:00:00',
      seriesId: 'series-1',
      state: 'planned',
      timeZone: 'Europe/Berlin',
      updatedAt: now,
      ...overrides,
    },
    id: 'occurrence-1',
    type: 'taskRecurrenceOccurrence',
  }
}

function preview() {
  return {
    attributes: {
      costClass: 'low',
      definitionHash,
      occurrences: [
        {
          cardDates: {},
          occurrenceKey,
          placeholderToken,
          provenance: ['weekdays'],
          scheduledFor: now,
          scheduledForLocal: '2026-08-18T12:00:00',
          timeZone: 'Europe/Berlin',
        },
      ],
      summary: { human: 'Every weekday' },
    },
    id: 'preview',
    type: 'taskRecurrencePreview',
  }
}

function operation(
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' = 'pending',
  updatedAt = now,
  overrides: Record<string, unknown> = {},
) {
  return {
    attributes: {
      completedAt: status === 'pending' || status === 'running' ? null : updatedAt,
      createdAt: now,
      errorCode: status === 'failed' ? 'task-recurrence-operation-failed' : null,
      operationType: 'recheck',
      progress: null,
      result: status === 'succeeded' ? { claimed: true } : null,
      seriesId: 'series-1',
      status,
      updatedAt,
      ...overrides,
    },
    id: 'operation-1',
    type: 'taskRecurrenceOperation',
  }
}

function response(
  data: unknown,
  options: { etag?: string; headers?: Record<string, string>; status?: number } = {},
) {
  return new Response(JSON.stringify({ data, meta: { requestId: 'request-1' } }), {
    headers: {
      'content-type': 'application/json',
      ...(options.etag ? { 'cache-control': cacheControl, etag: options.etag } : {}),
      ...options.headers,
    },
    status: options.status ?? 200,
  })
}

describe('task recurrence SDK surface', () => {
  it('validates every public recurrence resource and rejects drift', () => {
    expect(taskRecurrenceValidator(recurrence())).toBe(true)
    expect(taskRecurrenceVersionValidator(version())).toBe(true)
    expect(taskRecurrenceOccurrenceValidator(occurrence())).toBe(true)
    expect(taskRecurrencePreviewValidator(preview())).toBe(true)
    expect(taskRecurrenceOperationValidator(operation())).toBe(true)
    expect(
      taskRecurrenceEventValidator({
        attributes: { acceptedAt: now },
        id: 'event-1',
        type: 'taskRecurrenceEvent',
      }),
    ).toBe(true)
    expect(taskRecurrenceValidator(recurrence({ revision: 'legacy' }))).toBe(false)
    expect(
      taskRecurrenceValidator(
        recurrence({
          currentDefinition: {
            ...recurrence().attributes.currentDefinition,
            policy: { ...policy(), unsafe: true },
          },
        }),
      ),
    ).toBe(false)
    expect(taskRecurrenceOccurrenceValidator(occurrence({ occurrenceKey: 'arbitrary' }))).toBe(
      false,
    )
    expect(
      taskRecurrenceOccurrenceValidator(
        occurrence({
          detachedAt: now,
          detachedBy: 'user-1',
          detachedCardId: 'task-1',
          state: 'materialized',
        }),
      ),
    ).toBe(true)
    expect(
      taskRecurrenceOccurrenceValidator(
        occurrence({ detachedAt: now, detachedBy: 'user-1', detachedCardId: null }),
      ),
    ).toBe(false)
    expect(
      taskRecurrenceOccurrenceValidator(
        occurrence({
          override: { action: 'materialize', templatePatch: { unknown: true } },
        }),
      ),
    ).toBe(false)
  })

  it('validates advanced catch-up, overlap and invalid-day policy contracts', () => {
    const base = policy()
    const advanced = {
      ...base,
      candidates: {
        ...base.candidates,
        rule: { ...base.candidates.rule, invalidDayHandling: 'previous-valid-day' },
      },
      materialization: {
        catchUp: 'bounded',
        catchUpLimit: 5,
        lead: { unit: 'business-day', value: 2 },
        overlap: 'pause-series',
      },
    }
    expect(
      taskRecurrenceValidator(
        recurrence({
          currentDefinition: {
            ...recurrence().attributes.currentDefinition,
            policy: advanced,
          },
        }),
      ),
    ).toBe(true)

    const { catchUpLimit: ignored, ...invalidMaterialization } = advanced.materialization
    expect(ignored).toBe(5)
    const invalid = { ...advanced, materialization: invalidMaterialization }
    expect(
      taskRecurrenceValidator(
        recurrence({
          currentDefinition: {
            ...recurrence().attributes.currentDefinition,
            policy: invalid,
          },
        }),
      ),
    ).toBe(false)
  })

  it('validates explicit completion-transition recurrence semantics', () => {
    const base = policy()
    const repeatedCompletion = {
      ...base,
      candidates: {
        completionMode: 'every-completion-transition',
        event: 'completed',
        nodeId: 'completion',
        op: 'afterOccurrenceEvent',
      },
    }
    expect(
      taskRecurrenceValidator(
        recurrence({
          currentDefinition: {
            ...recurrence().attributes.currentDefinition,
            policy: repeatedCompletion,
          },
        }),
      ),
    ).toBe(true)

    const invalid = {
      ...repeatedCompletion,
      candidates: { ...repeatedCompletion.candidates, completionMode: 'sometimes' },
    }
    expect(
      taskRecurrenceValidator(
        recurrence({
          currentDefinition: {
            ...recurrence().attributes.currentDefinition,
            policy: invalid,
          },
        }),
      ),
    ).toBe(false)
  })

  it('uses stable filters, encoded identifiers, and strong read ETags', async () => {
    const calls: Array<{ method: string; url: URL }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ method: String(init?.method ?? 'GET'), url })
      if (url.pathname.endsWith('/preview') && init?.method === 'POST') return response(preview())
      if (url.pathname.endsWith('/preview')) return response(preview())
      if (url.pathname.endsWith('/occurrences/seed%3Aexternal_1')) {
        return response(occurrence({ occurrenceKey: 'seed:external_1' }), {
          etag: `"tro1-${revision}"`,
        })
      }
      if (url.pathname.endsWith('/series%3Aone')) {
        return response({ ...recurrence(), id: 'series:one' }, { etag: `"tr1-${revision}"` })
      }
      return new Response(
        JSON.stringify({
          data: [recurrence()],
          meta: { page: { limit: 20, nextCursor: null }, requestId: 'request-list' },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      )
    })
    const client = new TeamGridClient({ fetch, token })

    await client.taskRecurrences.list({ limit: 20, projectId: 'project-1', status: 'active' })
    await client.taskRecurrences.get('series:one')
    await client.taskRecurrences.preview({ policy: { kind: 'calendar' } } as never)
    await client.taskRecurrences.previewStored('series-1', {
      count: 3,
      from: new Date(now),
      until: '2026-08-25T10:00:00.000Z',
    })
    await client.taskRecurrenceOccurrences.get('series-1', 'seed:external_1')

    expect(calls.map(({ method, url }) => `${method} ${url.pathname}${url.search}`)).toEqual([
      'GET /v1/task-recurrences?limit=20&projectId=project-1&status=active',
      'GET /v1/task-recurrences/series%3Aone',
      'POST /v1/task-recurrences/preview',
      'GET /v1/task-recurrences/series-1/preview?count=3&from=2026-08-18T10%3A00%3A00.000Z&until=2026-08-25T10%3A00%3A00.000Z',
      'GET /v1/task-recurrences/series-1/occurrences/seed%3Aexternal_1',
    ])
  })

  it('enforces idempotent creation metadata and recurrence compare-and-set headers', async () => {
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
      if (path === '/v1/task-recurrences' && init?.method === 'POST') {
        return response(recurrence({ replayed: true }), {
          etag: `"tr1-${revision}"`,
          headers: { 'idempotency-replayed': 'true' },
          status: 200,
        })
      }
      if (path.includes('/occurrences/')) {
        return response(occurrence({ revision: nextRevision }), {
          etag: `"tro1-${nextRevision}"`,
        })
      }
      return response(recurrence({ revision: nextRevision }), { etag: `"tr1-${nextRevision}"` })
    })
    const client = new TeamGridClient({ fetch, token })

    await client.taskRecurrences.create(
      { policy: { kind: 'calendar' }, sourceTaskId: 'task-1' } as never,
      { idempotencyKey: 'recurrence-create-1' },
    )
    await client.taskRecurrences.update('series-1', { name: 'Renamed' }, { ifMatch: revision })
    await client.taskRecurrences.removeFromTasks('series-1', { ifMatch: revision })
    await client.taskRecurrenceVersions.restore(
      'series-1',
      'version-1',
      { changeReason: 'Rollback' },
      { ifMatch: `tr1-${revision}` },
    )
    await client.taskRecurrenceOccurrences.override(
      'series-1',
      occurrenceKey,
      { action: 'skip' },
      { ifMatch: revision },
    )
    await client.taskRecurrenceOccurrences.override(
      'series-1',
      occurrenceKey,
      { action: 'skip', placeholderToken },
      { createIfMissing: true },
    )
    await client.taskRecurrenceOccurrences.clearOverride('series-1', occurrenceKey, {
      ifMatch: `tro1-${revision}`,
    })

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /v1/task-recurrences',
      'PATCH /v1/task-recurrences/series-1',
      'POST /v1/task-recurrences/series-1/remove-from-tasks',
      'POST /v1/task-recurrences/series-1/versions/version-1/restore',
      `PUT /v1/task-recurrences/series-1/occurrences/${occurrenceKey}/override`,
      `PUT /v1/task-recurrences/series-1/occurrences/${occurrenceKey}/override`,
      `DELETE /v1/task-recurrences/series-1/occurrences/${occurrenceKey}/override`,
    ])
    expect(calls[0]?.headers.get('idempotency-key')).toBe('recurrence-create-1')
    expect(calls.slice(1, 4).map((call) => call.headers.get('if-match'))).toEqual([
      `"tr1-${revision}"`,
      `"tr1-${revision}"`,
      `"tr1-${revision}"`,
    ])
    expect(calls[4]?.headers.get('if-match')).toBe(`"tro1-${revision}"`)
    expect(calls[5]?.headers.get('if-none-match')).toBe('*')
    expect(calls[5]?.headers.get('if-match')).toBeNull()
    expect(calls[6]?.headers.get('if-match')).toBe(`"tro1-${revision}"`)
  })

  it('validates async operation acceptance, cancellation, and monotonic polling', async () => {
    const responses = [
      response(operation(), {
        headers: { location: '/v1/task-recurrence-operations/operation-1' },
        status: 202,
      }),
      response(operation('running', '2026-08-18T10:00:01.000Z')),
      response(operation('succeeded', '2026-08-18T10:00:02.000Z')),
      response(operation('cancelled', '2026-08-18T10:00:03.000Z')),
    ]
    const fetch = vi.fn(async () => responses.shift() as Response)
    const client = new TeamGridClient({ fetch, token })

    await expect(client.taskRecurrences.recheck('series-1')).resolves.toMatchObject({
      data: { id: 'operation-1' },
    })
    await expect(
      client.taskRecurrenceOperations.wait('operation-1', {
        maxWaitMs: 1000,
        pollIntervalMs: 100,
      }),
    ).resolves.toMatchObject({ data: { attributes: { status: 'succeeded' } } })
    await expect(client.taskRecurrenceOperations.cancel('operation-1')).resolves.toMatchObject({
      data: { attributes: { status: 'cancelled' } },
    })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('accepts a location-bound asynchronous draft preview', async () => {
    const fetch = vi.fn(async () =>
      response(
        operation('pending', now, {
          operationType: 'preview',
          seriesId: null,
        }),
        {
          headers: { location: '/v1/task-recurrence-operations/operation-1' },
          status: 202,
        },
      ),
    )
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.taskRecurrences.preview({ policy: policy() } as never),
    ).resolves.toMatchObject({
      data: { attributes: { operationType: 'preview' }, id: 'operation-1' },
    })
  })

  it('fails closed on inconsistent replay metadata or missing strong-cache metadata', async () => {
    const responses = [
      response(recurrence({ replayed: false }), {
        etag: `"tr1-${revision}"`,
        headers: { 'idempotency-replayed': 'true' },
        status: 200,
      }),
      response(recurrence(), { headers: { etag: `"tr1-${revision}"` } }),
    ]
    const client = new TeamGridClient({ fetch: async () => responses.shift() as Response, token })

    await expect(client.taskRecurrences.create({ policy: {} } as never)).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
    await expect(client.taskRecurrences.get('series-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })
})

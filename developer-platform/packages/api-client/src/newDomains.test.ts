import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import { TeamGridClientError } from './errors.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const admRevision = `adm1-${'a'.repeat(64)}` as const
const autRevision = `aut1-${'b'.repeat(64)}` as const
const runRevision = `aur1-${'c'.repeat(64)}` as const
const versionId = `dav1-${'d'.repeat(64)}` as const
const intentToken = `ex1.1800000000.${'e'.repeat(32)}.${'f'.repeat(64)}`
const date = '2026-07-19T10:00:00.000Z'
const endDate = '2026-07-20T00:00:00.000Z'
const appointmentRevision = `ap1-${'1'.repeat(64)}` as const
const absenceRevision = `ab1-${'2'.repeat(64)}` as const
const commentRevision = `cmt1-${'3'.repeat(64)}` as const
const documentStrongEtag = `"doc1-${Buffer.from(date).toString('base64url')}"` as const

function appointmentResource() {
  return {
    attributes: {
      allDay: false,
      archived: false,
      busy: true,
      createdAt: date,
      description: 'Planning agenda',
      end: { at: endDate, timeZone: 'Europe/Berlin' },
      location: 'Office',
      managedBy: 'teamgrid',
      redacted: false,
      revision: appointmentRevision,
      start: { at: date, timeZone: 'Europe/Berlin' },
      title: 'Planning',
      updatedAt: date,
      userId: 'user-1',
      visibility: 'default',
    },
    id: 'appointment-1',
    type: 'appointment',
  } as const
}

function absenceResource() {
  return {
    attributes: {
      archived: false,
      archivedAt: null,
      createdAt: date,
      end: endDate,
      reason: 'Holiday',
      revision: absenceRevision,
      start: date,
      userId: 'user-1',
    },
    id: 'absence-1',
    type: 'absence',
  } as const
}

function availabilityResource() {
  return {
    attributes: {
      end: endDate,
      start: date,
      timeZone: 'Europe/Berlin',
      users: [{ intervals: [{ end: endDate, start: date }], userId: 'user-1' }],
    },
    id: 'current',
    type: 'availability',
  } as const
}

function activityResource() {
  return {
    attributes: {
      actorId: 'user-1',
      eventType: 'task.completed',
      occurredAt: date,
      target: { id: 'task-1', type: 'task' },
    },
    id: 'activity-1',
    type: 'activityEvent',
  } as const
}

function commentResource() {
  return {
    attributes: {
      archived: false,
      authorId: 'user-1',
      createdAt: date,
      revision: commentRevision,
      target: { id: 'task-1', type: 'task' },
      text: 'Hello',
      updatedAt: date,
    },
    id: 'comment-1',
    type: 'comment',
  } as const
}

function documentResource(includeContent: boolean) {
  return {
    attributes: {
      archived: false,
      ...(includeContent ? { content: 'Text' } : {}),
      createdAt: date,
      createdBy: 'user-1',
      name: 'Notes',
      updatedAt: date,
      updatedBy: 'user-1',
    },
    id: 'document-1',
    type: 'document',
  } as const
}

function fileResource() {
  return {
    attributes: {
      archived: false,
      blocked: false,
      contentRevision: 1,
      createdAt: date,
      createdBy: 'user-1',
      downloadAvailable: true,
      links: [{ entityId: 'task-1', entityType: 'task', linkType: 'attachment' }],
      metadataRevision: 1,
      mimeType: 'text/plain',
      name: 'notes.txt',
      previewStatus: 'ready',
      size: 4,
      space: 'tasks',
      syncRevision: 1,
      updatedAt: date,
      updatedBy: 'user-1',
    },
    id: 'file-1',
    type: 'file',
  } as const
}

function transferIntent(kind: 'download' | 'upload') {
  const id = kind === 'download' ? 'download-intent-1' : 'upload-1'
  return {
    attributes: {
      file: { fileName: 'notes.txt', mimeType: 'text/plain', size: 4 },
      transfer: {
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        headers:
          kind === 'upload'
            ? {
                'content-length': '4',
                'content-type': 'text/plain',
                'x-amz-acl': 'private',
              }
            : {},
        id,
        maxSize: kind === 'upload' ? 4 : null,
        method: kind === 'upload' ? 'PUT' : 'GET',
        url: `https://storage.example.test/object?signature=opaque`,
      },
    },
    id,
    type: kind === 'upload' ? 'fileUploadIntent' : 'fileDownloadIntent',
  } as const
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function resource(data: unknown, status = 200, headers: HeadersInit = {}) {
  return json({ data, meta: { requestId: 'request-1' } }, status, headers)
}

function page(data: unknown[], limit = 50) {
  return json({
    data,
    meta: { page: { limit, nextCursor: null }, requestId: 'request-1' },
  })
}

const member = {
  attributes: {
    currentGroupId: null,
    disabled: false,
    groupIds: ['group-1'],
    owner: false,
    revision: admRevision,
    roleId: 'role-1',
    status: 'active',
  },
  id: 'member-1',
  type: 'member',
} as const

const invitation = {
  attributes: {
    createdAt: date,
    revision: admRevision,
    roleId: 'role-1',
    status: 'pending',
    workspaceOwner: false,
  },
  id: 'invitation-1',
  type: 'invitation',
} as const

const role = {
  attributes: {
    default: false,
    description: '',
    memberCount: 1,
    name: 'Developer',
    permissions: ['tasks:read'],
    revision: admRevision,
    system: false,
  },
  id: 'role-1',
  type: 'role',
} as const

const group = {
  attributes: {
    createdAt: date,
    memberIds: ['member-1'],
    name: 'Platform',
    revision: admRevision,
    visibility: 'members',
  },
  id: 'group-1',
  type: 'group',
} as const

describe('final TeamGrid SDK domains', () => {
  it('covers calendar, collaboration, document, and file operation surfaces', async () => {
    const calls = new Set<string>()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      calls.add(`${method} ${url.pathname}`)
      if (url.pathname === '/v1/availability') {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ timeZone: 'Europe/Berlin' })
        return resource(availabilityResource())
      }
      if (
        ['/v1/activity', '/v1/comments', '/v1/documents', '/v1/files'].includes(url.pathname) &&
        method === 'GET'
      ) {
        const responseData = {
          '/v1/activity': activityResource(),
          '/v1/comments': commentResource(),
          '/v1/documents': documentResource(false),
          '/v1/files': fileResource(),
        }[url.pathname]
        return page([responseData])
      }
      if (['/v1/appointments', '/v1/absences'].includes(url.pathname) && method === 'GET') {
        return page([
          url.pathname.endsWith('appointments') ? appointmentResource() : absenceResource(),
        ])
      }
      if (url.pathname === '/v1/file-upload-intents' && method === 'POST') {
        return resource(transferIntent('upload'), 201)
      }
      if (url.pathname.endsWith('/finalize')) {
        return resource(fileResource(), 200, { etag: '"file-1"' })
      }
      if (url.pathname === '/v1/file-upload-intents/upload-1' && method === 'DELETE') {
        return resource({
          attributes: { replayed: false, state: 'canceled' },
          id: 'upload-1',
          type: 'fileUploadIntent',
        })
      }
      if (url.pathname.endsWith('/download-intent')) {
        return resource(transferIntent('download'), 201)
      }
      const root = url.pathname.split('/')[2]
      const responseData =
        root === 'appointments'
          ? appointmentResource()
          : root === 'absences'
            ? absenceResource()
            : root === 'comments'
              ? commentResource()
              : root === 'documents'
                ? documentResource(!url.pathname.endsWith('/restore') && method !== 'DELETE')
                : fileResource()
      const etag =
        root === 'appointments'
          ? `"${appointmentRevision}"`
          : root === 'absences'
            ? `"${absenceRevision}"`
            : root === 'comments'
              ? `"${commentRevision}"`
              : root === 'documents'
                ? documentStrongEtag
                : '"file-1"'
      const status = method === 'POST' && !url.pathname.endsWith('/restore') ? 201 : 200
      return resource(responseData, status, { etag })
    })
    const client = new TeamGridClient({ fetch, token })
    const calendar = { end: '2026-07-20T00:00:00.000Z', start: date }

    await client.appointments.list(calendar)
    await client.appointments.create({ end: { at: calendar.end }, start: { at: calendar.start } })
    await client.appointments.get('appointment-1')
    await client.appointments.update(
      'appointment-1',
      { title: 'Changed' },
      { ifMatch: appointmentRevision },
    )
    await client.appointments.archive('appointment-1', { ifMatch: appointmentRevision })
    await client.appointments.restore('appointment-1', { ifMatch: appointmentRevision })
    await client.absences.list(calendar)
    await client.absences.create(calendar)
    await client.absences.get('absence-1')
    await client.absences.update('absence-1', { reason: 'Holiday' }, { ifMatch: absenceRevision })
    await client.absences.archive('absence-1', { ifMatch: absenceRevision })
    await client.absences.restore('absence-1', { ifMatch: absenceRevision })
    await client.availability.list({ ...calendar, timeZone: 'Europe/Berlin' })
    await client.activity.list({ targetId: 'task-1', targetType: 'task' })
    await client.comments.list({ targetId: 'task-1', targetType: 'task' })
    await client.comments.create({ targetId: 'task-1', targetType: 'task', text: 'Hello' })
    await client.comments.get('comment-1')
    await client.comments.archive('comment-1', { ifMatch: commentRevision })
    await client.comments.restore('comment-1', { ifMatch: commentRevision })
    await client.documents.list()
    await client.documents.create({ content: 'Text', name: 'Notes' })
    await client.documents.get('document-1')
    await client.documents.update(
      'document-1',
      { name: 'Changed' },
      { ifMatch: documentStrongEtag },
    )
    await client.documents.archive('document-1', { ifMatch: documentStrongEtag })
    await client.documents.restore('document-1', { ifMatch: documentStrongEtag })
    await client.files.list()
    await client.files.get('file-1')
    await client.files.rename('file-1', { name: 'changed.txt' }, { ifMatch: '"file-1"' })
    await client.files.archive('file-1', { ifMatch: '"file-1"' })
    await client.files.restore('file-1', { ifMatch: '"file-1"' })
    await client.files.createDownloadIntent('file-1')
    await client.fileUploadIntents.create({
      destination: { id: 'task-1', type: 'task' },
      file: { fileName: 'notes.txt', mimeType: 'text/plain', size: 4 },
    })
    await client.fileUploadIntents.finalize('upload-1')
    await client.fileUploadIntents.cancel('upload-1')

    expect(calls).toContain('POST /v1/file-upload-intents/upload-1/finalize')
    expect(calls).toContain('POST /v1/files/file-1/download-intent')
  })

  it('rejects extra or context-inappropriate calendar, collaboration, and storage fields', async () => {
    const cases: Array<{
      call: (client: TeamGridClient) => Promise<unknown>
      response: Response
    }> = [
      {
        call: (client) => client.appointments.list({ end: endDate, start: date }),
        response: page([
          {
            ...appointmentResource(),
            attributes: {
              ...appointmentResource().attributes,
              providerPayload: { eventId: 'private' },
            },
          },
        ]),
      },
      {
        call: (client) =>
          client.availability.list({
            end: endDate,
            start: date,
            timeZone: 'Europe/Berlin',
          }),
        response: resource({
          ...availabilityResource(),
          attributes: { ...availabilityResource().attributes, rawEvents: [] },
        }),
      },
      {
        call: (client) => client.comments.list({ targetId: 'task-1', targetType: 'task' }),
        response: page([
          {
            ...commentResource(),
            attributes: { ...commentResource().attributes, attachments: [] },
          },
        ]),
      },
      {
        call: (client) => client.documents.list(),
        response: page([documentResource(true)]),
      },
      {
        call: (client) => client.files.list(),
        response: page([
          {
            ...fileResource(),
            attributes: { ...fileResource().attributes, objectKey: 'private/object' },
          },
        ]),
      },
    ]

    for (const testCase of cases) {
      const client = new TeamGridClient({ fetch: vi.fn(async () => testCase.response), token })
      await expect(testCase.call(client)).rejects.toMatchObject({ code: 'invalid_api_response' })
    }
  })

  it('binds appointment, document, and file ETags to their returned resource revisions', async () => {
    const appointmentClient = new TeamGridClient({
      fetch: vi.fn(async () =>
        resource(appointmentResource(), 200, { etag: `"ap1-${'0'.repeat(64)}"` }),
      ),
      token,
    })
    await expect(appointmentClient.appointments.get('appointment-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })

    const documentClient = new TeamGridClient({
      fetch: vi.fn(async () => resource(documentResource(true), 200, { etag: '"doc1-wrong"' })),
      token,
    })
    await expect(documentClient.documents.get('document-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
    expect(() =>
      documentClient.documents.update(
        'document-1',
        { name: 'Changed' },
        { ifMatch: '"doc1-wrong"' },
      ),
    ).toThrow(TeamGridClientError)

    const fileClient = new TeamGridClient({
      fetch: vi.fn(async () => resource(fileResource(), 200, { etag: '"file-2"' })),
      token,
    })
    await expect(fileClient.files.get('file-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('rejects unsafe, leaked, expired, or size-inconsistent file transfer intents', async () => {
    const base = transferIntent('upload')
    const unsafeTransfers: Array<Record<string, unknown>> = [
      { url: 'http://storage.example.test/object' },
      { url: 'https://user:password@storage.example.test/object' },
      { url: 'https://storage.example.test/object#signature' },
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
      { expiresAt: new Date(Date.now() + 21 * 60 * 1000).toISOString() },
      { headers: { authorization: 'Bearer leaked' } },
      {
        headers: {
          'content-length': '4',
          'content-type': 'text/plain',
          'x-amz-acl': 'public-read',
        },
      },
      { headers: { 'content-length': '5', 'content-type': 'text/plain' } },
      { maxSize: 3 },
      { method: 'GET' },
    ]

    for (const transferOverride of unsafeTransfers) {
      const invalidIntent = {
        ...base,
        attributes: {
          ...base.attributes,
          transfer: { ...base.attributes.transfer, ...transferOverride },
        },
      }
      const client = new TeamGridClient({
        fetch: vi.fn(async () => resource(invalidIntent, 201)),
        token,
      })
      await expect(
        client.fileUploadIntents.create({
          destination: { id: 'task-1', type: 'task' },
          file: { fileName: 'notes.txt', mimeType: 'text/plain', size: 4 },
        }),
      ).rejects.toMatchObject({ code: 'invalid_api_response' })
    }

    const invalidDownload = {
      ...transferIntent('download'),
      attributes: {
        ...transferIntent('download').attributes,
        transfer: {
          ...transferIntent('download').attributes.transfer,
          headers: { authorization: 'Bearer leaked' },
          maxSize: 4,
          method: 'PUT',
        },
      },
    }
    const downloadClient = new TeamGridClient({
      fetch: vi.fn(async () => resource(invalidDownload, 201)),
      token,
    })
    await expect(downloadClient.files.createDownloadIntent('file-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('covers administration paths with idempotency and strong preconditions', async () => {
    const calls: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      calls.push(`${method} ${url.pathname}`)
      const headers = new Headers(init?.headers)
      if (['PATCH', 'DELETE'].includes(method) || url.pathname.endsWith('/resend')) {
        expect(headers.get('if-match')).toBe(`"${admRevision}"`)
      }
      if (method === 'POST' && !url.pathname.endsWith('/resend')) {
        expect(headers.get('idempotency-key')).toBeTruthy()
      }
      if (method === 'DELETE' || url.pathname.endsWith('/resend')) {
        return new Response(null, {
          headers: url.pathname.endsWith('/resend')
            ? { 'idempotency-replayed': 'false' }
            : undefined,
          status: 204,
        })
      }
      const responseData = url.pathname.startsWith('/v1/members')
        ? member
        : url.pathname.startsWith('/v1/invitations')
          ? invitation
          : url.pathname.startsWith('/v1/roles')
            ? role
            : group
      if (
        method === 'GET' &&
        !/\/(member|invitation|role|group)-1(?:\/role)?$/.test(url.pathname)
      ) {
        return page([responseData])
      }
      return resource(responseData, method === 'POST' ? 201 : 200, {
        etag: `"${admRevision}"`,
      })
    })
    const client = new TeamGridClient({ fetch, token })

    await client.members.list()
    await client.members.get('member-1')
    await client.members.updateRole('member-1', { roleId: 'role-1' }, { ifMatch: admRevision })
    await client.members.remove('member-1', { ifMatch: admRevision })
    await client.invitations.list()
    await client.invitations.get('invitation-1')
    await client.invitations.create({
      email: 'person@example.com',
      firstname: 'Team',
      lastname: 'Grid',
    })
    await client.invitations.resend('invitation-1', { ifMatch: admRevision })
    await client.invitations.cancel('invitation-1', { ifMatch: admRevision })
    await client.roles.list()
    await client.roles.get('role-1')
    await client.roles.create({ name: 'Developer' })
    await client.roles.update('role-1', { name: 'Platform' }, { ifMatch: admRevision })
    await client.roles.remove('role-1', { ifMatch: admRevision })
    await client.groups.list()
    await client.groups.get('group-1')
    await client.groups.create({ name: 'Platform' })
    await client.groups.update('group-1', { visibility: 'members' }, { ifMatch: admRevision })
    await client.groups.remove('group-1', { ifMatch: admRevision })

    expect(calls).toContain('PATCH /v1/members/member-1/role')
    expect(calls).toContain('POST /v1/invitations/invitation-1/resend')
    expect(calls).toContain('DELETE /v1/roles/role-1')
    expect(calls).toContain('DELETE /v1/groups/group-1')
  })

  it('rejects partial PII, mismatched ETags, and malformed preconditions', async () => {
    const partialPii = {
      ...member,
      attributes: { ...member.attributes, email: 'person@example.com' },
    }
    const client = new TeamGridClient({
      fetch: vi.fn(async () => page([partialPii])),
      token,
    })
    await expect(client.members.list({ includePii: true })).rejects.toMatchObject({
      code: 'invalid_api_response',
    })

    const wrongEtag = new TeamGridClient({
      fetch: vi.fn(async () => resource(role, 200, { etag: `"adm1-${'0'.repeat(64)}"` })),
      token,
    })
    await expect(wrongEtag.roles.get('role-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
    expect(() =>
      wrongEtag.roles.update(
        'role-1',
        { name: 'Changed' },
        { ifMatch: 'bad' as typeof admRevision },
      ),
    ).toThrow(TeamGridClientError)
  })

  it('implements search, export jobs, download intents, and a bounded binary download', async () => {
    const csv = new TextEncoder().encode('id,name\n1,Example\n')
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/download')) {
        const headers = new Headers(init?.headers)
        expect(url.search).toBe('')
        expect(headers.get('x-teamgrid-export-download-intent')).toBe(intentToken)
        expect(init?.redirect).toBe('manual')
        return new Response(csv, {
          headers: {
            'cache-control': 'private, no-store',
            'content-disposition': `attachment; filename="teamgrid.csv"; filename*=UTF-8''teamgrid.csv`,
            'content-length': String(csv.byteLength),
            'content-type': 'text/csv; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'x-request-id': 'download-request',
          },
        })
      }
      if (url.pathname === '/v1/search') {
        expect(JSON.parse(String(init?.body))).toEqual({ term: 'Example', types: ['tasks'] })
        return resource([
          {
            attributes: { archived: false, completed: false, title: 'Example' },
            id: 'task-1',
            type: 'task',
          },
        ])
      }
      if (url.pathname.endsWith('/download-intent')) {
        return resource(
          {
            attributes: {
              expiresAt: '2027-01-15T08:00:00.000Z',
              fileName: 'teamgrid.csv',
              token: intentToken,
            },
            id: 'export-1',
            type: 'exportDownloadIntent',
          },
          201,
        )
      }
      if (init?.method === 'POST') {
        expect(new Headers(init.headers).get('idempotency-key')).toBeTruthy()
        return resource({ attributes: { replayed: false }, id: 'export-1', type: 'export' }, 201)
      }
      return resource({
        attributes: {
          createdAt: date,
          fields: ['id', 'name'],
          fileName: 'teamgrid.csv',
          format: 'csv',
          resourceType: 'tasks',
          state: 'running',
        },
        id: 'export-1',
        type: 'export',
      })
    })
    const client = new TeamGridClient({ fetch, token })
    const search = await client.search.query({ term: 'Example', types: ['tasks'] })
    expect(search.data[0]?.type).toBe('task')
    await client.exports.create({ fields: ['id', 'name'], resourceType: 'tasks' })
    await client.exports.get('export-1')
    await client.exports.createDownloadIntent('export-1')
    const download = await client.exports.download('export-1', { intentToken })
    expect(new TextDecoder().decode(download.data)).toContain('Example')
    expect(download).toMatchObject({
      contentType: 'text/csv; charset=utf-8',
      fileName: 'teamgrid.csv',
    })
    expect(download.transport).toMatchObject({ requestId: 'download-request', status: 200 })
    expect(JSON.stringify(download)).not.toContain(intentToken)
  })

  it('refuses export redirects, unsafe headers, and responses above the caller ceiling', async () => {
    const redirected = new TeamGridClient({
      fetch: vi.fn(
        async () =>
          new Response(null, { headers: { location: 'https://example.com' }, status: 302 }),
      ),
      token,
    })
    await expect(redirected.exports.download('export-1', { intentToken })).rejects.toMatchObject({
      code: 'unexpected_redirect',
    })

    const oversized = new TeamGridClient({
      fetch: vi.fn(
        async () =>
          new Response(new Uint8Array(10), {
            headers: {
              'cache-control': 'private, no-store',
              'content-disposition': `attachment; filename="x.csv"; filename*=UTF-8''x.csv`,
              'content-length': '10',
              'content-type': 'text/csv; charset=utf-8',
              'x-content-type-options': 'nosniff',
            },
          }),
      ),
      token,
    })
    await expect(
      oversized.exports.download('export-1', { intentToken, maxBytes: 5 }),
    ).rejects.toMatchObject({ code: 'export_download_too_large' })
    await expect(
      oversized.exports.download('export-1', {
        intentToken,
        maxBytes: 50 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
  })
})

const action = {
  attributes: {
    branches: [],
    config: [],
    description: 'Create a task',
    input: [],
    name: 'Task create',
    output: [],
    requiredScopes: ['tasks:write'],
  },
  id: 'taskCreate',
  type: 'automationAction',
} as const

function definition(replayed?: boolean) {
  return {
    attributes: {
      archived: false,
      createdAt: date,
      description: '',
      editable: true,
      flow: [{ actionId: 'taskCreate' }],
      name: 'Create task',
      ...(replayed === undefined ? {} : { replayed }),
      revision: autRevision,
      trigger: { data: { type: 'tasks' }, event: 'create' },
      updatedAt: date,
    },
    id: 'definition-1',
    type: 'automationDefinition',
  } as const
}

function run(replayed?: boolean) {
  return {
    attributes: {
      createdAt: date,
      definition: { id: 'definition-1', name: 'Create task' },
      ...(replayed === undefined ? {} : { replayed }),
      revision: runRevision,
      state: 'running',
    },
    id: 'run-1',
    type: 'automationRun',
  } as const
}

describe('automation and integration SDK surfaces', () => {
  it('covers action, definition, version, run, and installation operations', async () => {
    const calls: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      calls.push(`${method} ${url.pathname}`)
      const headers = new Headers(init?.headers)
      if (method !== 'GET' && url.pathname !== '/v1/automation-definitions') {
        expect(headers.get('if-match')).toMatch(/^"(?:aut|aur)1-[a-f0-9]{64}"$/)
      }
      if (url.pathname === '/v1/automation-actions') return resource([action])
      if (url.pathname === '/v1/integration-installations') {
        return resource([
          {
            attributes: {
              provider: 'slack',
              state: 'configured',
              target: { id: 'workspace-1', type: 'workspace' },
              verification: 'not_checked',
            },
            id: 'installation-1',
            type: 'integrationInstallation',
          },
        ])
      }
      if (url.pathname.endsWith('/versions')) {
        return page([
          {
            attributes: {
              ...definition().attributes,
              definitionId: 'definition-1',
              versionedAt: date,
            },
            id: versionId,
            type: 'automationDefinitionVersion',
          },
        ])
      }
      if (url.pathname.startsWith('/v1/automation-runs')) {
        const mutation = url.pathname.endsWith('/abort')
        if (!mutation && url.pathname === '/v1/automation-runs') return page([run()])
        return resource(run(mutation ? false : undefined), 200, { etag: `"${runRevision}"` })
      }
      const mutation = method !== 'GET'
      if (!mutation && url.pathname === '/v1/automation-definitions') return page([definition()])
      return resource(
        definition(mutation ? false : undefined),
        mutation && method === 'POST' && url.pathname === '/v1/automation-definitions' ? 201 : 200,
        {
          etag: `"${autRevision}"`,
        },
      )
    })
    const client = new TeamGridClient({ fetch, token })
    const input = {
      flow: [{ actionId: 'taskCreate' as const }],
      name: 'Create task',
      trigger: { data: { type: 'tasks' as const }, event: 'create' as const },
    }

    await client.automationActions.list()
    await client.automationDefinitions.list()
    await client.automationDefinitions.get('definition-1')
    await client.automationDefinitions.create(input)
    await client.automationDefinitions.update(
      'definition-1',
      { name: 'Changed' },
      { ifMatch: autRevision },
    )
    await client.automationDefinitions.archive('definition-1', { ifMatch: autRevision })
    await client.automationDefinitions.restore('definition-1', { ifMatch: autRevision })
    await client.automationDefinitionVersions.list('definition-1')
    await client.automationRuns.list({ definitionId: 'definition-1', state: 'running' })
    await client.automationRuns.get('run-1')
    await client.automationRuns.abort('run-1', { ifMatch: runRevision })
    await client.integrationInstallations.list()

    expect(calls).toContain('DELETE /v1/automation-definitions/definition-1')
    expect(calls).toContain('POST /v1/automation-definitions/definition-1/restore')
    expect(calls).toContain('POST /v1/automation-runs/run-1/abort')
  })

  it('rejects leaked restricted automation parameters', async () => {
    const leaked = definition()
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        resource(
          {
            ...leaked,
            attributes: {
              ...leaked.attributes,
              editable: false,
              flow: [{ actionId: 'taskCreate', config: [{ key: 'apiToken', value: 'secret' }] }],
            },
          },
          200,
          { etag: `"${autRevision}"` },
        ),
      ),
      token,
    })
    await expect(client.automationDefinitions.get('definition-1')).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })
})

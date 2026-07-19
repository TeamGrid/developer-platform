import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './config.js'
import { createProgram } from './program.js'
import { runCli } from './run.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function capture() {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    value += chunk
  })
  return { stream, value: () => value }
}

async function execute(
  args: string[],
  client: Record<string, unknown>,
  options: { input?: PassThrough; mode?: 'json' | 'jsonl' | 'table' } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-domains-'))
  const output = capture()
  const errorOutput = capture()
  const code = await runCli(['node', 'teamgrid', '--output', options.mode || 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: token },
    errorOutput: errorOutput.stream,
    input: options.input,
    output: output.stream,
  })
  return { code, error: errorOutput.value(), output: output.value() }
}

function page(data: unknown[] = []) {
  return {
    data,
    meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
  }
}

function commandPaths(root: Command) {
  const paths: string[] = []
  function visit(command: Command, ancestors: string[]) {
    for (const child of command.commands) {
      const path = [...ancestors, child.name()]
      paths.push(path.join(' '))
      visit(child, path)
    }
  }
  visit(root, [])
  return paths
}

describe('calendar, collaboration, and file commands', () => {
  it('registers all 34 commands from the public operation policy', () => {
    expect(commandPaths(createProgram())).toEqual(
      expect.arrayContaining([
        'absences archive',
        'absences create',
        'absences get',
        'absences list',
        'absences restore',
        'absences update',
        'activity list',
        'appointments archive',
        'appointments create',
        'appointments get',
        'appointments list',
        'appointments restore',
        'appointments update',
        'availability list',
        'comments archive',
        'comments create',
        'comments get',
        'comments list',
        'comments restore',
        'documents archive',
        'documents create',
        'documents get',
        'documents list',
        'documents restore',
        'documents update',
        'file-upload-intents cancel',
        'file-upload-intents create',
        'file-upload-intents finalize',
        'files archive',
        'files download-intent',
        'files get',
        'files list',
        'files rename',
        'files restore',
      ]),
    )
  })

  it('routes bounded calendar filters and supports all-page JSON and JSONL output', async () => {
    const list = vi.fn(async () => page())
    const pages = vi.fn(async function* () {
      yield page([{ id: 'appointment-1', type: 'appointment' }])
      yield page([{ id: 'appointment-2', type: 'appointment' }])
    })
    const client = { appointments: { list, pages } }
    const filters = [
      '--start',
      '2026-07-20T08:00:00.000Z',
      '--end',
      '2026-07-20T18:00:00.000Z',
      '--archived',
      'false',
      '--user-id',
      'user-1,user-2',
      '--user-id',
      'user-2,user-3',
    ]

    expect(
      (await execute(['appointments', 'list', ...filters, '--limit', '25'], client)).code,
    ).toBe(0)
    const expectedFilters = {
      archived: false,
      end: '2026-07-20T18:00:00.000Z',
      start: '2026-07-20T08:00:00.000Z',
      userId: ['user-1', 'user-2', 'user-3'],
    }
    expect(list).toHaveBeenCalledWith({ ...expectedFilters, limit: 25 })

    const json = await execute(
      ['appointments', 'list', ...filters, '--all', '--max-pages', '2'],
      client,
    )
    expect(json.code).toBe(0)
    expect(pages).toHaveBeenLastCalledWith(expectedFilters, { maxPages: 2 })
    expect(JSON.parse(json.output)).toEqual([
      { id: 'appointment-1', type: 'appointment' },
      { id: 'appointment-2', type: 'appointment' },
    ])

    const jsonl = await execute(
      ['appointments', 'list', ...filters, '--all', '--max-pages', '2'],
      client,
      { mode: 'jsonl' },
    )
    expect(jsonl.code).toBe(0)
    expect(
      jsonl.output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 'appointment-1', type: 'appointment' },
      { id: 'appointment-2', type: 'appointment' },
    ])
  })

  it('rejects missing calendar bounds and unsafe user ID collections locally', async () => {
    const missingBounds = await execute(['appointments', 'list'], { appointments: {} })
    expect(missingBounds.code).toBe(2)
    expect(missingBounds.error).toContain("required option '--start")

    const identifiers = Array.from({ length: 51 }, (_, index) => `user-${index}`).join(',')
    const tooManyUsers = await execute(
      [
        'appointments',
        'list',
        '--start',
        '2026-07-20T08:00:00.000Z',
        '--end',
        '2026-07-20T18:00:00.000Z',
        '--user-id',
        identifiers,
      ],
      { appointments: {} },
    )
    expect(tooManyUsers.code).toBe(2)
    expect(tooManyUsers.error).toContain('1 to 50 bounded identifiers')
  })

  it.each([
    ['appointments', 'appointment', `ap1-${'a'.repeat(64)}`],
    ['absences', 'absence', `ab1-${'b'.repeat(64)}`],
  ] as const)(
    'routes all %s lifecycle operations with JSON, idempotency, CAS, and confirmation',
    async (resource, singular, etag) => {
      const list = vi.fn(async () => page())
      const create = vi.fn(async () => ({ data: { id: `${singular}-1`, type: singular } }))
      const get = vi.fn(async () => ({ data: { id: `${singular}-1`, type: singular } }))
      const update = vi.fn(async () => ({ data: { id: `${singular}-1`, type: singular } }))
      const archive = vi.fn(async () => ({ data: { id: `${singular}-1`, type: singular } }))
      const restore = vi.fn(async () => ({ data: { id: `${singular}-1`, type: singular } }))
      const client = { [resource]: { archive, create, get, list, restore, update } }

      expect(
        (
          await execute(
            [
              resource,
              'list',
              '--start',
              '2026-07-20T08:00:00.000Z',
              '--end',
              '2026-07-20T18:00:00.000Z',
            ],
            client,
          )
        ).code,
      ).toBe(0)
      expect(list).toHaveBeenCalledWith({
        end: '2026-07-20T18:00:00.000Z',
        start: '2026-07-20T08:00:00.000Z',
      })
      expect(
        (
          await execute(
            [
              resource,
              'create',
              '--data',
              '{"start":{"at":"2026-07-20T08:00:00.000Z"},"end":{"at":"2026-07-20T09:00:00.000Z"}}',
              '--idempotency-key',
              `${singular}-create-1`,
            ],
            client,
          )
        ).code,
      ).toBe(0)
      expect(create).toHaveBeenCalledWith(
        {
          end: { at: '2026-07-20T09:00:00.000Z' },
          start: { at: '2026-07-20T08:00:00.000Z' },
        },
        { idempotencyKey: `${singular}-create-1` },
      )
      expect((await execute([resource, 'get', `${singular}-1`], client)).code).toBe(0)
      expect(get).toHaveBeenCalledWith(`${singular}-1`)
      expect(
        (
          await execute(
            [
              resource,
              'update',
              `${singular}-1`,
              '--data',
              '{"title":"Updated"}',
              '--if-match',
              etag,
            ],
            client,
          )
        ).code,
      ).toBe(0)
      expect(update).toHaveBeenCalledWith(`${singular}-1`, { title: 'Updated' }, { ifMatch: etag })

      const unconfirmed = await execute(
        [resource, 'archive', `${singular}-1`, '--if-match', etag],
        client,
        { input: new PassThrough() },
      )
      expect(unconfirmed.code).toBe(2)
      expect(unconfirmed.error).toContain('Use --yes')
      expect(archive).not.toHaveBeenCalled()
      expect(
        (await execute([resource, 'archive', `${singular}-1`, '--if-match', etag, '--yes'], client))
          .code,
      ).toBe(0)
      expect(archive).toHaveBeenCalledWith(`${singular}-1`, { ifMatch: etag })
      expect(
        (await execute([resource, 'restore', `${singular}-1`, '--if-match', etag], client)).code,
      ).toBe(0)
      expect(restore).toHaveBeenCalledWith(`${singular}-1`, { ifMatch: etag })
    },
  )

  it('routes availability and collaboration target filters without broad implicit access', async () => {
    const availabilityList = vi.fn(async () => ({ data: { id: 'availability-1' } }))
    const activityList = vi.fn(async () => page())
    const commentsList = vi.fn(async () => page())
    const client = {
      activity: { list: activityList },
      availability: { list: availabilityList },
      comments: { list: commentsList },
    }

    expect(
      (
        await execute(
          [
            'availability',
            'list',
            '--start',
            '2026-07-20T08:00:00.000Z',
            '--end',
            '2026-07-20T18:00:00.000Z',
            '--time-zone',
            'Europe/Berlin',
            '--user-id',
            'user-1,user-2',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(availabilityList).toHaveBeenCalledWith({
      end: '2026-07-20T18:00:00.000Z',
      start: '2026-07-20T08:00:00.000Z',
      timeZone: 'Europe/Berlin',
      userId: ['user-1', 'user-2'],
    })
    expect(
      (
        await execute(
          ['activity', 'list', '--target-type', 'task', '--target-id', 'task-1', '--limit', '20'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(activityList).toHaveBeenCalledWith({ limit: 20, targetId: 'task-1', targetType: 'task' })
    expect(
      (
        await execute(
          [
            'comments',
            'list',
            '--target-type',
            'project',
            '--target-id',
            'project-1',
            '--archived',
            'true',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(commentsList).toHaveBeenCalledWith({
      archived: true,
      targetId: 'project-1',
      targetType: 'project',
    })

    const missingTarget = await execute(['activity', 'list', '--target-type', 'task'], client)
    expect(missingTarget.code).toBe(2)
    expect(missingTarget.error).toContain("required option '--target-id")
  })

  it('routes comment creation and lifecycle with stdin JSON, idempotency, CAS, and confirmation', async () => {
    const create = vi.fn(async () => ({ data: { id: 'comment-1', type: 'comment' } }))
    const get = vi.fn(async () => ({ data: { id: 'comment-1', type: 'comment' } }))
    const archive = vi.fn(async () => ({ data: { id: 'comment-1', type: 'comment' } }))
    const restore = vi.fn(async () => ({ data: { id: 'comment-1', type: 'comment' } }))
    const client = { comments: { archive, create, get, restore } }
    const etag = `cmt1-${'c'.repeat(64)}`
    const input = new PassThrough()
    input.end('{"targetId":"task-1","targetType":"task","text":"Ready"}')

    expect(
      (
        await execute(
          ['comments', 'create', '--data', '-', '--idempotency-key', 'comment-create-1'],
          client,
          { input },
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { targetId: 'task-1', targetType: 'task', text: 'Ready' },
      { idempotencyKey: 'comment-create-1' },
    )
    expect((await execute(['comments', 'get', 'comment-1'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('comment-1')

    const unconfirmed = await execute(
      ['comments', 'archive', 'comment-1', '--if-match', etag],
      client,
      { input: new PassThrough() },
    )
    expect(unconfirmed.code).toBe(2)
    expect(archive).not.toHaveBeenCalled()
    expect(
      (await execute(['comments', 'archive', 'comment-1', '--if-match', etag, '--yes'], client))
        .code,
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith('comment-1', { ifMatch: etag })
    expect(
      (await execute(['comments', 'restore', 'comment-1', '--if-match', etag], client)).code,
    ).toBe(0)
    expect(restore).toHaveBeenCalledWith('comment-1', { ifMatch: etag })
  })

  it('routes all document operations with filters, idempotency, CAS, and confirmation', async () => {
    const list = vi.fn(async () => page())
    const create = vi.fn(async () => ({ data: { id: 'document-1', type: 'document' } }))
    const get = vi.fn(async () => ({ data: { id: 'document-1', type: 'document' } }))
    const update = vi.fn(async () => ({ data: { id: 'document-1', type: 'document' } }))
    const archive = vi.fn(async () => ({ data: { id: 'document-1', type: 'document' } }))
    const restore = vi.fn(async () => ({ data: { id: 'document-1', type: 'document' } }))
    const client = { documents: { archive, create, get, list, restore, update } }
    const etag = '"doc1-revision-1"'

    expect((await execute(['documents', 'list', '--archived', 'true'], client)).code).toBe(0)
    expect(list).toHaveBeenCalledWith({ archived: true })
    expect(
      (
        await execute(
          [
            'documents',
            'create',
            '--data',
            '{"content":"Text","name":"Notes"}',
            '--idempotency-key',
            'document-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { content: 'Text', name: 'Notes' },
      { idempotencyKey: 'document-create-1' },
    )
    expect((await execute(['documents', 'get', 'document-1'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('document-1')
    expect(
      (
        await execute(
          ['documents', 'update', 'document-1', '--data', '{"name":"Renamed"}', '--if-match', etag],
          client,
        )
      ).code,
    ).toBe(0)
    expect(update).toHaveBeenCalledWith('document-1', { name: 'Renamed' }, { ifMatch: etag })
    expect(
      (await execute(['documents', 'archive', 'document-1', '--if-match', etag, '--yes'], client))
        .code,
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith('document-1', { ifMatch: etag })
    expect(
      (await execute(['documents', 'restore', 'document-1', '--if-match', etag], client)).code,
    ).toBe(0)
    expect(restore).toHaveBeenCalledWith('document-1', { ifMatch: etag })
  })

  it('routes all file metadata operations without accepting transfer URLs or tokens', async () => {
    const list = vi.fn(async () => page())
    const get = vi.fn(async () => ({ data: { id: 'file-1', type: 'file' } }))
    const rename = vi.fn(async () => ({ data: { id: 'file-1', type: 'file' } }))
    const archive = vi.fn(async () => ({ data: { id: 'file-1', type: 'file' } }))
    const restore = vi.fn(async () => ({ data: { id: 'file-1', type: 'file' } }))
    const createDownloadIntent = vi.fn(async () => ({
      data: {
        attributes: { expiresAt: '2026-07-20T12:00:00.000Z', url: 'https://signed.invalid' },
      },
    }))
    const client = { files: { archive, createDownloadIntent, get, list, rename, restore } }
    const etag = '"file-1"'

    expect(
      (
        await execute(
          [
            'files',
            'list',
            '--archived',
            'false',
            '--entity-type',
            'task',
            '--entity-id',
            'task-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({ archived: false, entityId: 'task-1', entityType: 'task' })
    expect((await execute(['files', 'get', 'file-1', '--archived', 'true'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('file-1', { archived: true })
    expect(
      (
        await execute(
          ['files', 'rename', 'file-1', '--data', '{"name":"brief.pdf"}', '--if-match', etag],
          client,
        )
      ).code,
    ).toBe(0)
    expect(rename).toHaveBeenCalledWith('file-1', { name: 'brief.pdf' }, { ifMatch: etag })
    expect(
      (await execute(['files', 'archive', 'file-1', '--if-match', etag, '--yes'], client)).code,
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith('file-1', { ifMatch: etag })
    expect((await execute(['files', 'restore', 'file-1', '--if-match', etag], client)).code).toBe(0)
    expect(restore).toHaveBeenCalledWith('file-1', { ifMatch: etag })
    expect((await execute(['files', 'download-intent', 'file-1'], client)).code).toBe(0)
    expect(createDownloadIntent).toHaveBeenCalledWith('file-1')

    const unsafeArgument = await execute(
      ['files', 'download-intent', 'file-1', '--url', 'https://attacker.invalid'],
      client,
    )
    expect(unsafeArgument.code).toBe(2)
    expect(unsafeArgument.error).toContain('unknown option')
  })

  it('routes upload intent creation/finalization and confirms cancellation', async () => {
    const create = vi.fn(async () => ({ data: { id: 'upload-1', type: 'fileUploadIntent' } }))
    const finalize = vi.fn(async () => ({ data: { id: 'file-1', type: 'file' } }))
    const cancel = vi.fn(async () => ({ data: { id: 'upload-1', type: 'fileUploadIntent' } }))
    const client = { fileUploadIntents: { cancel, create, finalize } }

    expect(
      (
        await execute(
          [
            'file-upload-intents',
            'create',
            '--data',
            '{"contentType":"application/pdf","fileName":"brief.pdf","size":1024}',
            '--idempotency-key',
            'upload-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { contentType: 'application/pdf', fileName: 'brief.pdf', size: 1024 },
      { idempotencyKey: 'upload-create-1' },
    )
    expect((await execute(['file-upload-intents', 'finalize', 'upload-1'], client)).code).toBe(0)
    expect(finalize).toHaveBeenCalledWith('upload-1')

    const unconfirmed = await execute(['file-upload-intents', 'cancel', 'upload-1'], client, {
      input: new PassThrough(),
    })
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.error).toContain('Use --yes')
    expect(cancel).not.toHaveBeenCalled()
    expect(
      (await execute(['file-upload-intents', 'cancel', 'upload-1', '--yes'], client)).code,
    ).toBe(0)
    expect(cancel).toHaveBeenCalledWith('upload-1')
  })
})

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
  options: { input?: PassThrough } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-task-recurrences-'))
  const output = capture()
  const errorOutput = capture()
  const code = await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: token },
    errorOutput: errorOutput.stream,
    input: options.input,
    output: output.stream,
  })
  return { code, error: errorOutput.value(), output: output.value() }
}

function page() {
  return {
    data: [],
    meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
  }
}

function resource(id = 'series-1') {
  return { data: { id, type: 'taskRecurrence' } }
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

describe('task recurrence commands', () => {
  it('registers the complete recurrence operation policy', () => {
    expect(commandPaths(createProgram())).toEqual(
      expect.arrayContaining([
        'task-recurrences list',
        'task-recurrences create',
        'task-recurrences preview',
        'task-recurrences get',
        'task-recurrences update',
        'task-recurrences archive',
        'task-recurrences preview-stored',
        'task-recurrences restore',
        'task-recurrences pause',
        'task-recurrences resume',
        'task-recurrences end',
        'task-recurrences owner',
        'task-recurrences template-from-task',
        'task-recurrences versions list',
        'task-recurrences versions get',
        'task-recurrences versions restore',
        'task-recurrences occurrences list',
        'task-recurrences occurrences get',
        'task-recurrences occurrences override',
        'task-recurrences occurrences clear-override',
        'task-recurrences occurrences retry',
        'task-recurrences recheck',
        'task-recurrences events submit',
        'task-recurrence-operations get',
        'task-recurrence-operations wait',
        'task-recurrence-operations cancel',
      ]),
    )
  })

  it('routes list, read, and preview filters without inventing defaults', async () => {
    const list = vi.fn(async () => page())
    const get = vi.fn(async () => resource())
    const previewStored = vi.fn(async () => ({
      data: { id: 'preview', type: 'taskRecurrencePreview' },
    }))
    const client = { taskRecurrences: { get, list, previewStored } }

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'list',
            '--project-id',
            'project-1',
            '--status',
            'active',
            '--limit',
            '25',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({ limit: 25, projectId: 'project-1', status: 'active' })

    expect((await execute(['task-recurrences', 'get', 'series-1'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('series-1')

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'preview-stored',
            'series-1',
            '--count',
            '5',
            '--from',
            '2026-08-18T10:00:00.000Z',
            '--until',
            '2026-08-25T10:00:00.000Z',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(previewStored).toHaveBeenCalledWith('series-1', {
      count: 5,
      from: '2026-08-18T10:00:00.000Z',
      until: '2026-08-25T10:00:00.000Z',
    })
  })

  it('routes idempotent creation, draft preview, CAS updates, and series actions', async () => {
    const create = vi.fn(async () => resource())
    const preview = vi.fn(async () => ({ data: { id: 'preview', type: 'taskRecurrencePreview' } }))
    const update = vi.fn(async () => resource())
    const pause = vi.fn(async () => resource())
    const resume = vi.fn(async () => resource())
    const restore = vi.fn(async () => resource())
    const transferOwner = vi.fn(async () => resource())
    const applyTaskTemplate = vi.fn(async () => resource())
    const client = {
      taskRecurrences: {
        applyTaskTemplate,
        create,
        pause,
        preview,
        restore,
        resume,
        transferOwner,
        update,
      },
    }

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'create',
            '--data',
            '{"sourceTaskId":"task-1","policy":{}}',
            '--idempotency-key',
            'recurrence-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { policy: {}, sourceTaskId: 'task-1' },
      { idempotencyKey: 'recurrence-create-1' },
    )

    expect(
      (
        await execute(
          ['task-recurrences', 'preview', '--data', '{"policy":{"kind":"calendar"}}'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(preview).toHaveBeenCalledWith({ policy: { kind: 'calendar' } })

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'update',
            'series-1',
            '--data',
            '{"name":"Daily"}',
            '--if-match',
            'tr1-revision',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(update).toHaveBeenCalledWith('series-1', { name: 'Daily' }, { ifMatch: 'tr1-revision' })

    for (const action of ['pause', 'resume', 'restore'] as const) {
      expect(
        (
          await execute(
            ['task-recurrences', action, 'series-1', '--if-match', `tr1-${action}`],
            client,
          )
        ).code,
      ).toBe(0)
      expect({ pause, resume, restore }[action]).toHaveBeenCalledWith('series-1', {
        ifMatch: `tr1-${action}`,
      })
    }

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'owner',
            'series-1',
            '--data',
            '{"id":"user-2","kind":"user"}',
            '--if-match',
            'tr1-owner',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(transferOwner).toHaveBeenCalledWith(
      'series-1',
      { id: 'user-2', kind: 'user' },
      { ifMatch: 'tr1-owner' },
    )

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'template-from-task',
            'series-1',
            '--data',
            '{"sourceTaskId":"task-2"}',
            '--if-match',
            'tr1-template',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(applyTaskTemplate).toHaveBeenCalledWith(
      'series-1',
      { sourceTaskId: 'task-2' },
      { ifMatch: 'tr1-template' },
    )
  })

  it('routes immutable versions and occurrence ledger reads and writes', async () => {
    const versionList = vi.fn(async () => page())
    const versionGet = vi.fn(async () => resource('version-1'))
    const versionRestore = vi.fn(async () => resource())
    const occurrenceList = vi.fn(async () => page())
    const occurrenceGet = vi.fn(async () => resource('occurrence-1'))
    const override = vi.fn(async () => resource('occurrence-1'))
    const clearOverride = vi.fn(async () => resource('occurrence-1'))
    const retry = vi.fn(async () => resource('occurrence-1'))
    const client = {
      taskRecurrenceOccurrences: {
        clearOverride,
        get: occurrenceGet,
        list: occurrenceList,
        override,
        retry,
      },
      taskRecurrenceVersions: { get: versionGet, list: versionList, restore: versionRestore },
    }

    expect(
      (await execute(['task-recurrences', 'versions', 'list', 'series-1', '--limit', '10'], client))
        .code,
    ).toBe(0)
    expect(versionList).toHaveBeenCalledWith('series-1', { limit: 10 })
    expect(
      (await execute(['task-recurrences', 'versions', 'get', 'series-1', 'version-1'], client))
        .code,
    ).toBe(0)
    expect(versionGet).toHaveBeenCalledWith('series-1', 'version-1')
    expect(
      (
        await execute(
          [
            'task-recurrences',
            'versions',
            'restore',
            'series-1',
            'version-1',
            '--data',
            '{"changeReason":"Rollback"}',
            '--if-match',
            'tr1-version',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(versionRestore).toHaveBeenCalledWith(
      'series-1',
      'version-1',
      { changeReason: 'Rollback' },
      { ifMatch: 'tr1-version' },
    )

    expect(
      (
        await execute(
          ['task-recurrences', 'occurrences', 'list', 'series-1', '--cursor', 'next'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(occurrenceList).toHaveBeenCalledWith('series-1', { cursor: 'next' })
    expect(
      (await execute(['task-recurrences', 'occurrences', 'get', 'series-1', 'seed:crm_1'], client))
        .code,
    ).toBe(0)
    expect(occurrenceGet).toHaveBeenCalledWith('series-1', 'seed:crm_1')
    expect(
      (
        await execute(
          [
            'task-recurrences',
            'occurrences',
            'override',
            'series-1',
            'seed:crm_1',
            '--data',
            '{"action":"skip"}',
            '--if-match',
            'tro1-override',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(override).toHaveBeenCalledWith(
      'series-1',
      'seed:crm_1',
      { action: 'skip' },
      { ifMatch: 'tro1-override' },
    )
    expect(
      (
        await execute(
          [
            'task-recurrences',
            'occurrences',
            'override',
            'series-1',
            'seed:crm_1',
            '--data',
            '{"action":"skip","placeholderToken":"trp1.cHJvb2Y"}',
            '--create-if-missing',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(override).toHaveBeenLastCalledWith(
      'series-1',
      'seed:crm_1',
      { action: 'skip', placeholderToken: 'trp1.cHJvb2Y' },
      { createIfMissing: true },
    )
    expect(
      (
        await execute(
          [
            'task-recurrences',
            'occurrences',
            'clear-override',
            'series-1',
            'seed:crm_1',
            '--if-match',
            'tro1-clear',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(clearOverride).toHaveBeenCalledWith('series-1', 'seed:crm_1', { ifMatch: 'tro1-clear' })
    expect(
      (
        await execute(
          [
            'task-recurrences',
            'occurrences',
            'retry',
            'series-1',
            'seed:crm_1',
            '--if-match',
            'tro1-retry',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(retry).toHaveBeenCalledWith('series-1', 'seed:crm_1', { ifMatch: 'tro1-retry' })
  })

  it('routes external events and asynchronous recheck/operation workflows', async () => {
    const recheck = vi.fn(async () => resource('operation-1'))
    const wait = vi.fn(async () => resource('operation-1'))
    const submitEvent = vi.fn(async () => resource('event-1'))
    const get = vi.fn(async () => resource('operation-1'))
    const client = {
      taskRecurrenceOperations: { get, wait },
      taskRecurrences: { recheck, submitEvent },
    }

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'recheck',
            'series-1',
            '--wait',
            '--poll-interval',
            '250',
            '--max-wait',
            '5000',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(recheck).toHaveBeenCalledWith('series-1')
    expect(wait).toHaveBeenCalledWith('operation-1', { maxWaitMs: 5000, pollIntervalMs: 250 })

    expect(
      (
        await execute(
          [
            'task-recurrences',
            'events',
            'submit',
            'series-1',
            '--data',
            '{"eventId":"crm-1","eventType":"crm.deal.won","occurredAt":"2026-08-18T10:00:00.000Z","schemaVersion":1,"sourceId":"crm"}',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(submitEvent).toHaveBeenCalledWith('series-1', {
      eventId: 'crm-1',
      eventType: 'crm.deal.won',
      occurredAt: '2026-08-18T10:00:00.000Z',
      schemaVersion: 1,
      sourceId: 'crm',
    })

    expect((await execute(['task-recurrence-operations', 'get', 'operation-1'], client)).code).toBe(
      0,
    )
    expect(get).toHaveBeenCalledWith('operation-1')
    expect(
      (
        await execute(
          [
            'task-recurrence-operations',
            'wait',
            'operation-1',
            '--poll-interval',
            '300',
            '--max-wait',
            '6000',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(wait).toHaveBeenLastCalledWith('operation-1', {
      maxWaitMs: 6000,
      pollIntervalMs: 300,
    })
  })

  it('requires explicit confirmation for archive, end, and operation cancellation', async () => {
    const archive = vi.fn(async () => resource())
    const end = vi.fn(async () => resource())
    const cancel = vi.fn(async () => resource('operation-1'))
    const client = {
      taskRecurrenceOperations: { cancel },
      taskRecurrences: { archive, end },
    }

    const unconfirmed = await execute(
      ['task-recurrences', 'archive', 'series-1', '--if-match', 'tr1-archive'],
      client,
      { input: new PassThrough() },
    )
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.error).toContain('Use --yes')
    expect(archive).not.toHaveBeenCalled()

    expect(
      (
        await execute(
          ['task-recurrences', 'archive', 'series-1', '--if-match', 'tr1-archive', '--yes'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith('series-1', { ifMatch: 'tr1-archive' })

    expect(
      (
        await execute(
          ['task-recurrences', 'end', 'series-1', '--if-match', 'tr1-end', '--yes'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(end).toHaveBeenCalledWith('series-1', { ifMatch: 'tr1-end' })

    expect(
      (await execute(['task-recurrence-operations', 'cancel', 'operation-1', '--yes'], client))
        .code,
    ).toBe(0)
    expect(cancel).toHaveBeenCalledWith('operation-1')
  })
})

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

const exportIntentToken =
  // gitleaks:allow -- synthetic short-lived test intent
  `ex1.1234567890.${'a'.repeat(32)}.${'b'.repeat(64)}`

function captureText() {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    value += chunk
  })
  return { stream, value: () => value }
}

function captureBytes() {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  })
  return { bytes: () => Buffer.concat(chunks), stream }
}

async function execute(
  args: string[],
  client: Record<string, unknown>,
  overrides: {
    input?: PassThrough
    output?: PassThrough
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-expanded-'))
  const output = captureText()
  const errorOutput = captureText()
  const code = await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: token },
    errorOutput: errorOutput.stream,
    input: overrides.input,
    output: overrides.output || output.stream,
  })
  return { code, error: errorOutput.value(), output: output.value() }
}

function page() {
  return {
    data: [],
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

describe('expanded public capability commands', () => {
  it('registers the complete 36-command capability surface', () => {
    const paths = new Set(commandPaths(createProgram()))
    expect(Array.from(paths)).toEqual(
      expect.arrayContaining([
        'automation-actions list',
        'automation-definition-versions list',
        'automation-definitions archive',
        'automation-definitions create',
        'automation-definitions get',
        'automation-definitions list',
        'automation-definitions restore',
        'automation-definitions update',
        'automation-runs abort',
        'automation-runs get',
        'automation-runs list',
        'exports create',
        'exports download',
        'exports download-intent',
        'exports get',
        'groups create',
        'groups get',
        'groups list',
        'groups remove',
        'groups update',
        'integration-installations list',
        'invitations cancel',
        'invitations create',
        'invitations get',
        'invitations list',
        'invitations resend',
        'members get',
        'members list',
        'members remove',
        'members update-role',
        'roles create',
        'roles get',
        'roles list',
        'roles remove',
        'roles update',
        'search query',
      ]),
    )
  })

  it('routes member reads and role updates with explicit PII and CAS options', async () => {
    const list = vi.fn(async () => page())
    const get = vi.fn(async () => ({ data: { id: 'member-1', type: 'member' } }))
    const updateRole = vi.fn(async () => ({ data: { id: 'member-1', type: 'member' } }))
    const client = { members: { get, list, updateRole } }

    expect(
      (await execute(['members', 'list', '--include-pii', '--limit', '25'], client)).code,
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({ includePii: true, limit: 25 })
    expect((await execute(['members', 'get', 'member-1', '--include-pii'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('member-1', { includePii: true })
    expect(
      (
        await execute(
          [
            'members',
            'update-role',
            'member-1',
            '--data',
            '{"roleId":"role-2"}',
            '--if-match',
            'rev-4',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(updateRole).toHaveBeenCalledWith('member-1', { roleId: 'role-2' }, { ifMatch: 'rev-4' })
  })

  it('requires non-interactive confirmation for destructive member removal', async () => {
    const remove = vi.fn(async () => ({ status: 204 }))
    const client = { members: { remove } }
    const unconfirmed = await execute(
      ['members', 'remove', 'member-1', '--if-match', 'rev-1'],
      client,
      { input: new PassThrough() },
    )
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.error).toContain('Use --yes')
    expect(remove).not.toHaveBeenCalled()

    const confirmed = await execute(
      ['members', 'remove', 'member-1', '--if-match', 'rev-1', '--yes'],
      client,
    )
    expect(confirmed.code).toBe(0)
    expect(remove).toHaveBeenCalledWith('member-1', { ifMatch: 'rev-1' })
    expect(JSON.parse(confirmed.output)).toEqual({ id: 'member-1', removed: true, type: 'member' })
  })

  it('routes invitation reads and lifecycle mutations without exposing implicit defaults', async () => {
    const list = vi.fn(async () => page())
    const get = vi.fn(async () => ({ data: { id: 'invitation-1', type: 'invitation' } }))
    const create = vi.fn(async () => ({ data: { id: 'invitation-1', type: 'invitation' } }))
    const resend = vi.fn(async () => ({ status: 204 }))
    const cancel = vi.fn(async () => ({ status: 204 }))
    const client = { invitations: { cancel, create, get, list, resend } }

    expect((await execute(['invitations', 'list', '--include-pii'], client)).code).toBe(0)
    expect(list).toHaveBeenCalledWith({ includePii: true })
    expect(
      (await execute(['invitations', 'get', 'invitation-1', '--include-pii'], client)).code,
    ).toBe(0)
    expect(get).toHaveBeenCalledWith('invitation-1', { includePii: true })
    expect(
      (
        await execute(
          [
            'invitations',
            'create',
            '--data',
            '{"email":"developer@example.com","roleId":"role-1"}',
            '--idempotency-key',
            'invite-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { email: 'developer@example.com', roleId: 'role-1' },
      { idempotencyKey: 'invite-create-1' },
    )
    expect(
      (
        await execute(
          [
            'invitations',
            'resend',
            'invitation-1',
            '--if-match',
            'rev-2',
            '--idempotency-key',
            'invite-resend-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(resend).toHaveBeenCalledWith('invitation-1', {
      idempotencyKey: 'invite-resend-1',
      ifMatch: 'rev-2',
    })
    expect(
      (
        await execute(
          ['invitations', 'cancel', 'invitation-1', '--if-match', 'rev-3', '--yes'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(cancel).toHaveBeenCalledWith('invitation-1', { ifMatch: 'rev-3' })
  })

  it.each([
    ['roles', 'role'],
    ['groups', 'group'],
  ] as const)(
    'routes all %s CRUD commands with idempotency, CAS, and removal confirmation',
    async (resource, type) => {
      const list = vi.fn(async () => page())
      const get = vi.fn(async () => ({ data: { id: `${type}-1`, type } }))
      const create = vi.fn(async () => ({ data: { id: `${type}-1`, type } }))
      const update = vi.fn(async () => ({ data: { id: `${type}-1`, type } }))
      const remove = vi.fn(async () => ({ status: 204 }))
      const client = { [resource]: { create, get, list, remove, update } }

      expect((await execute([resource, 'list', '--limit', '10'], client)).code).toBe(0)
      expect(list).toHaveBeenCalledWith({ limit: 10 })
      expect((await execute([resource, 'get', `${type}-1`], client)).code).toBe(0)
      expect(get).toHaveBeenCalledWith(`${type}-1`)
      expect(
        (
          await execute(
            [
              resource,
              'create',
              '--data',
              '{"name":"Operations"}',
              '--idempotency-key',
              `${type}-create-1`,
            ],
            client,
          )
        ).code,
      ).toBe(0)
      expect(create).toHaveBeenCalledWith(
        { name: 'Operations' },
        { idempotencyKey: `${type}-create-1` },
      )
      expect(
        (
          await execute(
            [
              resource,
              'update',
              `${type}-1`,
              '--data',
              '{"name":"Delivery"}',
              '--if-match',
              'rev-2',
            ],
            client,
          )
        ).code,
      ).toBe(0)
      expect(update).toHaveBeenCalledWith(`${type}-1`, { name: 'Delivery' }, { ifMatch: 'rev-2' })
      expect(
        (await execute([resource, 'remove', `${type}-1`, '--if-match', 'rev-3', '--yes'], client))
          .code,
      ).toBe(0)
      expect(remove).toHaveBeenCalledWith(`${type}-1`, { ifMatch: 'rev-3' })
    },
  )

  it('routes search and export metadata operations through structured SDK calls', async () => {
    const query = vi.fn(async () => ({ data: [{ id: 'task-1', type: 'task' }] }))
    const create = vi.fn(async () => ({ data: { id: 'export-1', type: 'export' } }))
    const get = vi.fn(async () => ({ data: { id: 'export-1', type: 'export' } }))
    const createDownloadIntent = vi.fn(async () => ({
      data: {
        attributes: { token: exportIntentToken },
        id: 'export-1',
        type: 'exportDownloadIntent',
      },
    }))
    const client = { exports: { create, createDownloadIntent, get }, search: { query } }

    expect(
      (await execute(['search', 'query', '--data', '{"query":"launch","types":["task"]}'], client))
        .code,
    ).toBe(0)
    expect(query).toHaveBeenCalledWith({ query: 'launch', types: ['task'] })
    expect(
      (
        await execute(
          [
            'exports',
            'create',
            '--data',
            '{"format":"csv","resourceType":"task"}',
            '--idempotency-key',
            'export-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { format: 'csv', resourceType: 'task' },
      { idempotencyKey: 'export-create-1' },
    )
    expect((await execute(['exports', 'get', 'export-1'], client)).code).toBe(0)
    expect(get).toHaveBeenCalledWith('export-1')
    expect((await execute(['exports', 'download-intent', 'export-1'], client)).code).toBe(0)
    expect(createDownloadIntent).toHaveBeenCalledWith('export-1')
  })

  it('creates a short-lived intent internally and safely writes a new export file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-export-'))
    const path = join(directory, 'tasks.csv')
    const createDownloadIntent = vi.fn(async () => ({
      data: { attributes: { token: exportIntentToken }, id: 'export-1' },
    }))
    const download = vi.fn(async () => ({
      contentType: 'text/csv',
      data: Uint8Array.from(Buffer.from('id,title\ntask-1,Launch\n')),
      fileName: 'tasks.csv',
    }))
    const client = { exports: { createDownloadIntent, download } }

    const result = await execute(
      ['exports', 'download', 'export-1', '--file', path, '--max-bytes', '1024'],
      client,
    )
    expect(result.code).toBe(0)
    expect(createDownloadIntent).toHaveBeenCalledWith('export-1')
    expect(download).toHaveBeenCalledWith('export-1', {
      intentToken: exportIntentToken,
      maxBytes: 1024,
    })
    expect(await readFile(path, 'utf8')).toBe('id,title\ntask-1,Launch\n')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)

    await expect(writeFile(path, 'do-not-overwrite')).resolves.toBeUndefined()
    const overwrite = await execute(
      ['exports', 'download', 'export-1', '--file', path, '--max-bytes', '1024'],
      client,
    )
    expect(overwrite.code).toBe(2)
    expect(overwrite.error).toContain('existing files are never overwritten')
    expect(await readFile(path, 'utf8')).toBe('do-not-overwrite')
  })

  it('accepts an export intent only over stdin and writes raw bytes only to redirected stdout', async () => {
    const input = new PassThrough()
    input.end(`${exportIntentToken}\n`)
    const output = captureBytes()
    const createDownloadIntent = vi.fn()
    const download = vi.fn(async () => ({ data: Uint8Array.from([0, 1, 2, 255]) }))
    const result = await execute(
      ['exports', 'download', 'export-1', '--intent-token-stdin', '--stdout'],
      { exports: { createDownloadIntent, download } },
      { input, output: output.stream },
    )
    expect(result.code).toBe(0)
    expect(createDownloadIntent).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledWith('export-1', {
      intentToken: exportIntentToken,
      maxBytes: 50 * 1024 * 1024,
    })
    expect(output.bytes()).toEqual(Buffer.from([0, 1, 2, 255]))
  })

  it('rejects ambiguous export destinations and binary output to a terminal', async () => {
    const noDestination = await execute(['exports', 'download', 'export-1'], { exports: {} })
    expect(noDestination.code).toBe(2)
    expect(noDestination.error).toContain('exactly one export destination')

    const output = captureBytes()
    Object.assign(output.stream, { isTTY: true })
    const client = {
      exports: {
        createDownloadIntent: vi.fn(async () => ({
          data: { attributes: { token: exportIntentToken }, id: 'export-1' },
        })),
        download: vi.fn(async () => ({ data: Uint8Array.from([1, 2, 3]) })),
      },
    }
    const terminal = await execute(['exports', 'download', 'export-1', '--stdout'], client, {
      output: output.stream,
    })
    expect(terminal.code).toBe(2)
    expect(terminal.error).toContain('Refusing to write export bytes to a terminal')
    expect(output.bytes()).toHaveLength(0)
  })

  it('routes automation catalogs, filtered definitions, versions, runs, and integrations', async () => {
    const actionsList = vi.fn(async () => ({ data: [] }))
    const definitionsList = vi.fn(async () => page())
    const definitionsGet = vi.fn(async () => ({ data: { id: 'definition-1' } }))
    const versionsList = vi.fn(async () => page())
    const runsList = vi.fn(async () => page())
    const runsGet = vi.fn(async () => ({ data: { id: 'run-1' } }))
    const installationsList = vi.fn(async () => ({ data: [] }))
    const client = {
      automationActions: { list: actionsList },
      automationDefinitions: { get: definitionsGet, list: definitionsList },
      automationDefinitionVersions: { list: versionsList },
      automationRuns: { get: runsGet, list: runsList },
      integrationInstallations: { list: installationsList },
    }

    expect((await execute(['automation-actions', 'list'], client)).code).toBe(0)
    expect(actionsList).toHaveBeenCalledOnce()
    expect(
      (
        await execute(
          ['automation-definitions', 'list', '--archived', 'true', '--limit', '12'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(definitionsList).toHaveBeenCalledWith({ archived: true, limit: 12 })
    expect((await execute(['automation-definitions', 'get', 'definition-1'], client)).code).toBe(0)
    expect(definitionsGet).toHaveBeenCalledWith('definition-1')
    expect(
      (
        await execute(
          ['automation-definition-versions', 'list', 'definition-1', '--limit', '9'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(versionsList).toHaveBeenCalledWith('definition-1', { limit: 9 })
    expect(
      (
        await execute(
          [
            'automation-runs',
            'list',
            '--definition-id',
            'definition-1',
            '--reference-type',
            'task',
            '--reference-id',
            'task-1',
            '--state',
            'running',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(runsList).toHaveBeenCalledWith({
      definitionId: 'definition-1',
      referenceId: 'task-1',
      referenceType: 'task',
      state: 'running',
    })
    expect((await execute(['automation-runs', 'get', 'run-1'], client)).code).toBe(0)
    expect(runsGet).toHaveBeenCalledWith('run-1')
    expect((await execute(['integration-installations', 'list'], client)).code).toBe(0)
    expect(installationsList).toHaveBeenCalledOnce()
  })

  it('routes automation writes with idempotency, CAS, and destructive confirmations', async () => {
    const create = vi.fn(async () => ({ data: { id: 'definition-1' } }))
    const update = vi.fn(async () => ({ data: { id: 'definition-1' } }))
    const archive = vi.fn(async () => ({ data: { id: 'definition-1' } }))
    const restore = vi.fn(async () => ({ data: { id: 'definition-1' } }))
    const abort = vi.fn(async () => ({ data: { id: 'run-1' } }))
    const client = {
      automationDefinitions: { archive, create, restore, update },
      automationRuns: { abort },
    }

    expect(
      (
        await execute(
          [
            'automation-definitions',
            'create',
            '--data',
            '{"name":"Notify owner"}',
            '--idempotency-key',
            'definition-create-1',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      { name: 'Notify owner' },
      { idempotencyKey: 'definition-create-1' },
    )
    expect(
      (
        await execute(
          [
            'automation-definitions',
            'update',
            'definition-1',
            '--data',
            '{"name":"Notify assignee"}',
            '--if-match',
            'rev-4',
          ],
          client,
        )
      ).code,
    ).toBe(0)
    expect(update).toHaveBeenCalledWith(
      'definition-1',
      { name: 'Notify assignee' },
      { ifMatch: 'rev-4' },
    )
    expect(
      (
        await execute(
          ['automation-definitions', 'archive', 'definition-1', '--if-match', 'rev-5', '--yes'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith('definition-1', { ifMatch: 'rev-5' })
    expect(
      (
        await execute(
          ['automation-definitions', 'restore', 'definition-1', '--if-match', 'rev-6'],
          client,
        )
      ).code,
    ).toBe(0)
    expect(restore).toHaveBeenCalledWith('definition-1', { ifMatch: 'rev-6' })
    expect(
      (await execute(['automation-runs', 'abort', 'run-1', '--if-match', 'rev-2', '--yes'], client))
        .code,
    ).toBe(0)
    expect(abort).toHaveBeenCalledWith('run-1', { ifMatch: 'rev-2' })
  })
})

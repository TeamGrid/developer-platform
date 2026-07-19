import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { TeamGridApiError, TeamGridClientError } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './config.js'
import { type CredentialStore, SystemCredentialStore } from './credentialStore.js'
import { exitCodeForError } from './program.js'
import { runCli } from './run.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>()
  async delete(profile: string) {
    this.values.delete(profile)
  }
  async get(profile: string) {
    return this.values.get(profile) || null
  }
  async set(profile: string, value: string) {
    this.values.set(profile, value)
  }
}

function capture() {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    value += chunk
  })
  return { stream, value: () => value }
}

describe('TeamGrid CLI', () => {
  it('keeps local usage errors distinct from network and protocol failures', () => {
    expect(exitCodeForError(new TeamGridClientError('invalid_json', 'invalid'))).toBe(2)
    expect(exitCodeForError(new TeamGridClientError('network_error', 'offline'))).toBe(1)
    expect(exitCodeForError(new TeamGridClientError('request_timeout', 'timeout'))).toBe(1)
    expect(exitCodeForError(new TeamGridClientError('invalid_api_response', 'invalid'))).toBe(1)
  })

  it('stores only non-secret profile metadata in a mode-0600 config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const path = join(directory, 'config.json')
    const store = new ConfigStore({ configPath: path })
    await store.save({
      currentProfile: 'default',
      profiles: {
        default: {
          cellId: 'us-mnz-001',
          createdAt: '2026-07-16T00:00:00.000Z',
          credentialId: '0123456789abcdef01234567',
          region: 'us',
        },
      },
      version: 1,
    })
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain(token)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await store.load()).toMatchObject({ currentProfile: 'default' })
  })

  it('does not change permissions on an existing config directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-existing-'))
    const store = new ConfigStore({ configPath: join(directory, 'config.json') })
    if (process.platform !== 'win32') await chmod(directory, 0o755)
    await store.save({ profiles: {}, version: 1 })
    if (process.platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o755)
  })

  it('creates a new config directory with mode 0700', async () => {
    const root = await mkdtemp(join(tmpdir(), 'teamgrid-cli-new-'))
    const directory = join(root, 'config')
    const path = join(directory, 'config.json')
    await new ConfigStore({ configPath: path }).save({ profiles: {}, version: 1 })
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it.each([
    { argv: ['--version'], label: 'version' },
    { argv: ['-V'], label: 'short version' },
    { argv: ['--help'], label: 'option help' },
    { argv: ['help'], label: 'help command' },
  ])('returns success for $label', async ({ argv }) => {
    const output = capture()
    const errorOutput = capture()
    const code = await runCli(['node', 'teamgrid', ...argv], {
      errorOutput: errorOutput.stream,
      output: output.stream,
    })
    expect(code).toBe(0)
    expect(output.value()).not.toBe('')
    expect(errorOutput.value()).toBe('')
  })

  it('reads the displayed version from the package manifest', async () => {
    const output = capture()
    const packageManifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(
      await runCli(['node', 'teamgrid', '--version'], {
        errorOutput: capture().stream,
        output: output.stream,
      }),
    ).toBe(0)
    expect(output.value().trim()).toBe(packageManifest.version)
  })

  it('prints API discovery data through the system client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const output = capture()
    const getApiVersion = vi.fn(async () => ({
      data: { documentation: 'https://developer.teamgridapp.com/api/v1', version: '1' },
      meta: { requestId: 'request-version' },
    }))
    expect(
      await runCli(['node', 'teamgrid', '--output', 'json', 'api-version'], {
        clientFactory: () => ({ system: { getApiVersion } }) as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        output: output.stream,
      }),
    ).toBe(0)
    expect(getApiVersion).toHaveBeenCalledOnce()
    expect(JSON.parse(output.value())).toEqual({
      documentation: 'https://developer.teamgridapp.com/api/v1',
      version: '1',
    })
  })

  it('reports Commander errors once and returns usage exit code 2', async () => {
    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', 'does-not-exist'], {
        errorOutput: errorOutput.stream,
        output: capture().stream,
      }),
    ).toBe(2)
    expect(errorOutput.value().match(/unknown command/g)).toHaveLength(1)
    expect(errorOutput.value()).not.toContain('teamgrid: error:')
  })

  it('renders control characters in Commander and API errors visibly', async () => {
    const commanderError = capture()
    expect(
      await runCli(['node', 'teamgrid', 'unknown\u001b[31m'], {
        errorOutput: commanderError.stream,
        output: capture().stream,
      }),
    ).toBe(2)
    expect(commanderError.value()).not.toContain('\u001b')
    expect(commanderError.value()).toContain('\\u001b')

    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const apiError = capture()
    expect(
      await runCli(['node', 'teamgrid', 'workspace'], {
        clientFactory: () =>
          ({
            workspace: {
              get: async () => {
                throw new TeamGridApiError({
                  errors: [
                    {
                      code: 'forbidden',
                      detail: 'Denied\u001b[31m\nspoofed',
                      status: '403',
                      title: 'Forbidden',
                    },
                  ],
                  requestId: 'request\u202e',
                  status: 403,
                })
              },
            },
          }) as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        errorOutput: apiError.stream,
        output: capture().stream,
      }),
    ).toBe(4)
    expect(apiError.value()).not.toContain('\u001b')
    expect(apiError.value()).not.toContain('\u202e')
    expect(apiError.value()).toContain('Denied\\u001b[31m\\nspoofed')
    expect(apiError.value()).toContain('request\\u202e')
  })

  it.each([
    ['--retries', '6', 'tasks', 'list'],
    ['tasks', 'list', '--limit', '201'],
    ['tasks', 'list', '--all', '--max-pages', '10001'],
  ])('rejects out-of-contract numeric options: %s', async (...argv) => {
    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', ...argv], {
        errorOutput: errorOutput.stream,
        output: capture().stream,
      }),
    ).toBe(2)
    expect(errorOutput.value()).toContain('must be an integer')
  })

  it('classifies insecure remote base URLs as usage errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', '--base-url', 'http://api.example.com/v1', 'workspace'], {
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        errorOutput: errorOutput.stream,
        output: capture().stream,
      }),
    ).toBe(2)
    expect(errorOutput.value()).toContain('Plain HTTP is allowed only for loopback')
  })

  it('passes keychain secrets over stdin and never as command arguments', async () => {
    const calls: Array<[string, string[], string?]> = []
    const run = vi.fn(async (command: string, args: string[], input?: string) => {
      calls.push([command, args, input])
      return { stderr: '', stdout: '' }
    })
    const store = new SystemCredentialStore({ currentPlatform: 'darwin', run })
    await store.set('default', token)
    expect(run).toHaveBeenCalledOnce()
    const [, args, input] = calls[0] || ['', []]
    expect(args).not.toContain(token)
    expect(input).toBe(token)
  })

  it('logs in from stdin and lists resources through the shared client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const configStore = new ConfigStore({ configPath: join(directory, 'config.json') })
    const credentialStore = new MemoryCredentialStore()
    const loginInput = new PassThrough()
    loginInput.end(`${token}\n`)
    const loginOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', '--output', 'json', 'auth', 'login', '--token-stdin'], {
        configStore,
        credentialStore,
        input: loginInput,
        output: loginOutput.stream,
      }),
    ).toBe(0)
    expect(credentialStore.values.get('default')).toBe(token)
    expect(JSON.parse(loginOutput.value())).toMatchObject({ name: 'default', region: 'us' })

    const output = capture()
    const list = vi.fn(async () => ({
      data: [{ attributes: { name: 'Task' }, id: 'task-1', type: 'task' }],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-1' },
    }))
    const code = await runCli(['node', 'teamgrid', '--output', 'json', 'tasks', 'list'], {
      clientFactory: () => ({ tasks: { list } }) as never,
      configStore,
      credentialStore,
      output: output.stream,
    })
    expect(code).toBe(0)
    expect(list).toHaveBeenCalledOnce()
    expect(JSON.parse(output.value()).data[0].id).toBe('task-1')
  })

  it('streams --all JSONL one page at a time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const configStore = new ConfigStore({ configPath: join(directory, 'config.json') })
    await configStore.save({
      currentProfile: 'default',
      profiles: {
        default: {
          cellId: 'us-mnz-001',
          createdAt: '2026-07-16T00:00:00.000Z',
          credentialId: '0123456789abcdef01234567',
          region: 'us',
        },
      },
      version: 1,
    })
    const credentialStore = new MemoryCredentialStore()
    await credentialStore.set('default', token)
    const output = capture()
    async function* pages() {
      yield { data: [{ attributes: {}, id: 'task-1', type: 'task' }] }
      expect(output.value()).toContain('"id":"task-1"')
      yield { data: [{ attributes: {}, id: 'task-2', type: 'task' }] }
    }
    const code = await runCli(['node', 'teamgrid', '--output', 'jsonl', 'tasks', 'list', '--all'], {
      clientFactory: () => ({ tasks: { pages } }) as never,
      configStore,
      credentialStore,
      output: output.stream,
    })
    expect(code).toBe(0)
    expect(output.value().trim().split('\n')).toHaveLength(2)
  })

  it.each([
    {
      argv: [
        'projects',
        'create',
        '--data',
        '{"name":"Platform"}',
        '--idempotency-key',
        'project-1',
      ],
      client: 'projects' as const,
      expectedArgs: [{ name: 'Platform' }, { idempotencyKey: 'project-1' }],
      method: 'create' as const,
      resource: { attributes: { name: 'Platform' }, id: 'project-1', type: 'project' },
    },
    {
      argv: ['projects', 'update', 'project-1', '--data', '{"color":"#123456"}'],
      client: 'projects' as const,
      expectedArgs: ['project-1', { color: '#123456' }],
      method: 'update' as const,
      resource: { attributes: { color: '#123456' }, id: 'project-1', type: 'project' },
    },
    {
      argv: [
        'contacts',
        'create',
        '--data',
        '{"type":"person","firstName":"Ada"}',
        '--idempotency-key',
        'contact-1',
      ],
      client: 'contacts' as const,
      expectedArgs: [{ firstName: 'Ada', type: 'person' }, { idempotencyKey: 'contact-1' }],
      method: 'create' as const,
      resource: { attributes: { firstName: 'Ada' }, id: 'contact-1', type: 'contact' },
    },
    {
      argv: ['contacts', 'update', 'contact-1', '--data', '{"nickname":"Ada"}'],
      client: 'contacts' as const,
      expectedArgs: ['contact-1', { nickname: 'Ada' }],
      method: 'update' as const,
      resource: { attributes: { nickname: 'Ada' }, id: 'contact-1', type: 'contact' },
    },
    {
      argv: [
        'lists',
        'create',
        '--data',
        '{"name":"Delivery","type":"tasks"}',
        '--idempotency-key',
        'list-1',
      ],
      client: 'lists' as const,
      expectedArgs: [{ name: 'Delivery', type: 'tasks' }, { idempotencyKey: 'list-1' }],
      method: 'create' as const,
      resource: { attributes: { name: 'Delivery' }, id: 'list-1', type: 'list' },
    },
    {
      argv: ['lists', 'get', 'list-1'],
      client: 'lists' as const,
      expectedArgs: ['list-1'],
      method: 'get' as const,
      resource: { attributes: { name: 'Delivery' }, id: 'list-1', type: 'list' },
    },
    {
      argv: ['lists', 'update', 'list-1', '--data', '{"name":"Shipping"}'],
      client: 'lists' as const,
      expectedArgs: ['list-1', { name: 'Shipping' }],
      method: 'update' as const,
      resource: { attributes: { name: 'Shipping' }, id: 'list-1', type: 'list' },
    },
    {
      argv: ['lists', 'restore', 'list-1'],
      client: 'lists' as const,
      expectedArgs: ['list-1'],
      method: 'restore' as const,
      resource: { attributes: { archived: false }, id: 'list-1', type: 'list' },
    },
    {
      argv: [
        'services',
        'create',
        '--data',
        '{"title":"Consulting","billable":true}',
        '--idempotency-key',
        'service-1',
      ],
      client: 'services' as const,
      expectedArgs: [{ billable: true, title: 'Consulting' }, { idempotencyKey: 'service-1' }],
      method: 'create' as const,
      resource: { attributes: { title: 'Consulting' }, id: 'service-1', type: 'service' },
    },
    {
      argv: ['services', 'get', 'service-1'],
      client: 'services' as const,
      expectedArgs: ['service-1'],
      method: 'get' as const,
      resource: { attributes: { title: 'Consulting' }, id: 'service-1', type: 'service' },
    },
    {
      argv: [
        'tags',
        'create',
        '--data',
        '{"name":"Priority","color":"#123456"}',
        '--idempotency-key',
        'tag-1',
      ],
      client: 'tags' as const,
      expectedArgs: [{ color: '#123456', name: 'Priority' }, { idempotencyKey: 'tag-1' }],
      method: 'create' as const,
      resource: { attributes: { name: 'Priority' }, id: 'tag-1', type: 'tag' },
    },
    {
      argv: ['tags', 'update', 'tag-1', '--data', '{"color":"#654321"}'],
      client: 'tags' as const,
      expectedArgs: ['tag-1', { color: '#654321' }],
      method: 'update' as const,
      resource: { attributes: { color: '#654321' }, id: 'tag-1', type: 'tag' },
    },
    {
      argv: ['tags', 'restore', 'tag-1'],
      client: 'tags' as const,
      expectedArgs: ['tag-1'],
      method: 'restore' as const,
      resource: { attributes: { archived: false }, id: 'tag-1', type: 'tag' },
    },
    {
      argv: ['tasks', 'restore', 'task-1'],
      client: 'tasks' as const,
      expectedArgs: ['task-1'],
      method: 'restore' as const,
      resource: { attributes: { archived: false }, id: 'task-1', type: 'task' },
    },
    {
      argv: ['project-statements', 'restore', 'statement-1'],
      client: 'projectStatements' as const,
      expectedArgs: ['statement-1'],
      method: 'restore' as const,
      resource: {
        attributes: { archived: false },
        id: 'statement-1',
        type: 'projectStatement',
      },
    },
    {
      argv: ['tasks', 'complete', 'task-1'],
      client: 'tasks' as const,
      expectedArgs: ['task-1'],
      method: 'complete' as const,
      resource: { attributes: { completed: true }, id: 'task-1', type: 'task' },
    },
    {
      argv: ['tasks', 'reopen', 'task-1'],
      client: 'tasks' as const,
      expectedArgs: ['task-1'],
      method: 'reopen' as const,
      resource: { attributes: { completed: false }, id: 'task-1', type: 'task' },
    },
    {
      argv: ['time-entries', 'restore', 'time-1'],
      client: 'timeEntries' as const,
      expectedArgs: ['time-1'],
      method: 'restore' as const,
      resource: { attributes: { archived: false }, id: 'time-1', type: 'timeEntry' },
    },
    {
      argv: [
        'tasks',
        'timer',
        'start',
        'task-1',
        '--user-id',
        'user-1',
        '--at',
        '2026-07-19T10:00:00.000Z',
      ],
      client: 'tasks' as const,
      expectedArgs: ['task-1', { at: '2026-07-19T10:00:00.000Z', userId: 'user-1' }],
      method: 'startTimer' as const,
      resource: { attributes: { endAt: null }, id: 'time-1', type: 'timeEntry' },
    },
    {
      argv: ['tasks', 'timer', 'stop', 'task-1', '--user-id', 'user-1'],
      client: 'tasks' as const,
      expectedArgs: ['task-1', { userId: 'user-1' }],
      method: 'stopTimer' as const,
      resource: {
        attributes: { endAt: '2026-07-19T10:30:00.000Z' },
        id: 'time-1',
        type: 'timeEntry',
      },
    },
  ])(
    'routes $client $method through the SDK',
    async ({ argv, client, expectedArgs, method, resource }) => {
      const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
      const output = capture()
      const invoke = vi.fn(async () => ({
        data: resource,
        meta: { requestId: 'request-mutation' },
      }))

      expect(
        await runCli(['node', 'teamgrid', '--output', 'json', ...argv], {
          clientFactory: () => ({ [client]: { [method]: invoke } }) as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        }),
      ).toBe(0)
      expect(invoke).toHaveBeenCalledWith(...expectedArgs)
      expect(JSON.parse(output.value())).toEqual(resource)
    },
  )

  it.each([
    [
      'products',
      'products',
      ['--disabled', 'false', '--product-group-id', 'group-1'],
      { disabled: false, productGroupId: 'group-1' },
    ],
    ['product-groups', 'productGroups', ['--parent-id', 'group-1'], { parentId: 'group-1' }],
    [
      'project-statements',
      'projectStatements',
      [
        '--project-id',
        'project-1',
        '--product-id',
        'product-1',
        '--created-by',
        'user-1',
        '--date-from',
        '2026-07-01',
        '--date-to',
        '2026-07-31',
        '--type',
        'manual',
      ],
      {
        createdBy: 'user-1',
        dateFrom: '2026-07-01',
        dateTo: '2026-07-31',
        productId: 'product-1',
        projectId: 'project-1',
        type: 'manual',
      },
    ],
    [
      'webhook-deliveries',
      'webhookDeliveries',
      ['--event', 'task.created', '--state', 'failed', '--webhook-id', 'webhook-1'],
      { event: 'task.created', state: 'failed', webhookId: 'webhook-1' },
    ],
  ])('routes %s list filters through the SDK', async (command, clientKey, args, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const list = vi.fn(async () => ({
      data: [],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
    }))
    expect(
      await runCli(['node', 'teamgrid', '--output', 'json', command, 'list', ...args], {
        clientFactory: () => ({ [clientKey]: { list } }) as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        output: capture().stream,
      }),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith(expected)
  })

  it('creates a script-safe change checkpoint with repeatable and CSV filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const output = capture()
    const checkpoint = vi.fn(async () => ({
      data: [],
      meta: {
        page: { caughtUp: true, limit: 50, nextCursor: 'checkpoint-1' },
        requestId: 'request-checkpoint',
      },
    }))
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          'changes',
          'checkpoint',
          '--operation',
          'created,updated',
          '--operation',
          'deleted',
          '--resource-type',
          'project,task',
        ],
        {
          clientFactory: () => ({ changes: { checkpoint } }) as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        },
      ),
    ).toBe(0)
    expect(checkpoint).toHaveBeenCalledWith({
      operations: ['created', 'updated', 'deleted'],
      resourceTypes: ['project', 'task'],
    })
    expect(JSON.parse(output.value())).toEqual({
      caughtUp: true,
      cursor: 'checkpoint-1',
      requestId: 'request-checkpoint',
    })
  })

  it('reads one change page by default and emits an explicit JSONL checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const output = capture()
    const list = vi.fn(async () => ({
      data: [
        {
          attributes: { operation: 'updated', resourceId: 'task-1', resourceType: 'task' },
          id: 'change-1',
          type: 'changeEvent',
        },
      ],
      meta: {
        page: { caughtUp: true, limit: 10, nextCursor: 'checkpoint-2' },
        requestId: 'request-changes',
      },
    }))
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'jsonl',
          'changes',
          'list',
          '--cursor',
          'checkpoint-1',
          '--limit',
          '10',
          '--resource-type',
          'task',
        ],
        {
          clientFactory: () => ({ changes: { list } }) as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        },
      ),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({
      cursor: 'checkpoint-1',
      limit: 10,
      resourceTypes: ['task'],
    })
    expect(
      output
        .value()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        data: {
          attributes: { operation: 'updated', resourceId: 'task-1', resourceType: 'task' },
          id: 'change-1',
          type: 'changeEvent',
        },
        kind: 'change',
      },
      {
        caughtUp: true,
        cursor: 'checkpoint-2',
        kind: 'checkpoint',
        requestId: 'request-changes',
      },
    ])
  })

  it('bounds explicit change catch-up and never enters an implicit polling loop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const output = capture()
    const pages = vi.fn((_options, pagination) => {
      expect(pagination).toEqual({ maxPages: 3 })
      return (async function* changes() {
        yield {
          data: [{ attributes: {}, id: 'change-1', type: 'changeEvent' }],
          meta: {
            page: { caughtUp: false, limit: 50, nextCursor: 'checkpoint-2' },
            requestId: 'request-1',
          },
        }
        yield {
          data: [],
          meta: {
            page: { caughtUp: true, limit: 50, nextCursor: 'checkpoint-3' },
            requestId: 'request-2',
          },
        }
      })()
    })
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          'changes',
          'list',
          '--cursor',
          'checkpoint-1',
          '--all',
          '--max-pages',
          '3',
        ],
        {
          clientFactory: () => ({ changes: { pages } }) as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        },
      ),
    ).toBe(0)
    expect(pages).toHaveBeenCalledWith({ cursor: 'checkpoint-1' }, { maxPages: 3 })
    expect(JSON.parse(output.value())).toMatchObject({
      data: [{ id: 'change-1' }],
      meta: { page: { nextCursor: 'checkpoint-3' } },
    })
  })

  it('rejects unknown change filters locally', async () => {
    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', 'changes', 'list', '--operation', 'renamed'], {
        errorOutput: errorOutput.stream,
        output: capture().stream,
      }),
    ).toBe(2)
    expect(errorOutput.value()).toContain('created, deleted, updated')
  })

  it.each([
    ['lists', 'list', { archived: false, parentId: 'project-1', type: 'tasks' }],
    ['services', undefined, { archived: false }],
    ['tags', 'list', { archived: true }],
  ])(
    'supports metadata list aliases and filters for %s',
    async (resource, subcommand, expected) => {
      const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
      const output = capture()
      const list = vi.fn(async () => ({
        data: [],
        meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
      }))
      const args = [resource]
      if (subcommand) args.push(subcommand)
      args.push('--archived', String(expected.archived))
      if ('parentId' in expected) args.push('--parent-id', String(expected.parentId))
      if ('type' in expected) args.push('--type', String(expected.type))

      expect(
        await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
          clientFactory: () => ({ [resource]: { list } }) as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        }),
      ).toBe(0)
      expect(list).toHaveBeenCalledWith(expected)
      expect(JSON.parse(output.value()).data).toEqual([])
    },
  )

  it.each([
    ['tasks', 'task', 'task-1'],
    ['time-entries', 'timeEntry', 'time-1'],
    ['lists', 'list', 'list-1'],
    ['services', 'service', 'service-1'],
    ['tags', 'tag', 'tag-1'],
  ])('requires and honors explicit confirmation for %s archive', async (resource, type, id) => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const archive = vi.fn(async () => ({ status: 204 }))
    const errorOutput = capture()

    expect(
      await runCli(['node', 'teamgrid', resource, 'archive', id], {
        clientFactory: () =>
          ({ [resource === 'time-entries' ? 'timeEntries' : resource]: { archive } }) as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        errorOutput: errorOutput.stream,
        input: new PassThrough(),
        output: capture().stream,
      }),
    ).toBe(2)
    expect(archive).not.toHaveBeenCalled()
    expect(errorOutput.value()).toContain('Use --yes')

    const output = capture()
    expect(
      await runCli(['node', 'teamgrid', '--output', 'json', resource, 'archive', id, '--yes'], {
        clientFactory: () =>
          ({ [resource === 'time-entries' ? 'timeEntries' : resource]: { archive } }) as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        output: output.stream,
      }),
    ).toBe(0)
    expect(archive).toHaveBeenCalledWith(id)
    expect(JSON.parse(output.value())).toEqual({ archived: true, id, type })
  })

  it('routes custom-field definition filters and mutations through the SDK', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const list = vi.fn(async () => ({
      data: [],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
    }))
    const create = vi.fn(async () => ({
      data: { attributes: { title: 'Reference' }, id: 'field-1', type: 'customFieldDefinition' },
    }))
    const client = { customFieldDefinitions: { create, list } }
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          'custom-field-definitions',
          'list',
          '--archived',
          'false',
          '--default-enabled',
          'true',
          '--field-type',
          'text',
          '--target-type',
          'task',
        ],
        {
          clientFactory: () => client as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: capture().stream,
        },
      ),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({
      archived: false,
      defaultEnabled: true,
      fieldType: 'text',
      targetType: 'task',
    })

    const output = capture()
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          'custom-field-definitions',
          'create',
          '--data',
          '{"configuration":{"type":"text"},"fieldType":"text","targetType":"task","title":"Reference"}',
          '--idempotency-key',
          'field-create-1',
        ],
        {
          clientFactory: () => client as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        },
      ),
    ).toBe(0)
    expect(create).toHaveBeenCalledWith(
      {
        configuration: { type: 'text' },
        fieldType: 'text',
        targetType: 'task',
        title: 'Reference',
      },
      { idempotencyKey: 'field-create-1' },
    )
  })

  it('routes custom-field compare-and-set writes and confirms clears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const revision = `cfv1-${'1'.repeat(64)}`
    const set = vi.fn(async () => ({
      data: { attributes: { revision }, id: `cfv_${'a'.repeat(64)}`, type: 'customFieldValue' },
    }))
    const clear = vi.fn(async () => ({
      data: { attributes: { revision }, id: `cfv_${'a'.repeat(64)}`, type: 'customFieldValue' },
    }))
    const dependencies = {
      clientFactory: () => ({ customFieldValues: { clear, set } }) as never,
      configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
      environment: { TEAMGRID_API_TOKEN: token },
      output: capture().stream,
    }
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'custom-field-values',
          'set',
          'project',
          'project-1',
          'field1',
          '--data',
          '{"value":"ACME-42"}',
          '--if-match',
          revision,
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(set).toHaveBeenCalledWith(
      'project',
      'project-1',
      'field1',
      { value: 'ACME-42' },
      { ifMatch: revision },
    )
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'custom-field-values',
          'clear',
          'project',
          'project-1',
          'field1',
          '--if-match',
          revision,
          '--yes',
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(clear).toHaveBeenCalledWith('project', 'project-1', 'field1', {
      ifMatch: revision,
    })
  })

  it('filters templates and can wait for a credential-owned instantiation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const list = vi.fn(async () => ({
      data: [],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'template-list' },
    }))
    const instantiate = vi.fn(async () => ({
      data: { attributes: { state: 'pending' }, id: 'instantiation-1' },
    }))
    const wait = vi.fn(async () => ({
      data: { attributes: { state: 'succeeded' }, id: 'instantiation-1' },
    }))
    const dependencies = {
      clientFactory: () =>
        ({
          projectTemplateInstantiations: { wait },
          projectTemplates: { instantiate, list },
        }) as never,
      configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
      environment: { TEAMGRID_API_TOKEN: token },
      output: capture().stream,
    }
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'project-templates',
          'list',
          '--archived',
          'false',
          '--origin-project-id',
          'project-1',
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({ archived: false, originProjectId: 'project-1' })
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'project-templates',
          'instantiate',
          'template-1',
          '--data',
          '{"name":"Customer rollout"}',
          '--idempotency-key',
          'instantiate-1',
          '--wait',
          '--poll-interval',
          '250',
          '--max-wait',
          '5000',
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(instantiate).toHaveBeenCalledWith(
      'template-1',
      { name: 'Customer rollout' },
      { idempotencyKey: 'instantiate-1' },
    )
    expect(wait).toHaveBeenCalledWith('instantiation-1', {
      maxWaitMs: 5000,
      pollIntervalMs: 250,
    })
  })

  it('lists planned work and makes full replacement explicit and waitable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const revision = `pw1-${'1'.repeat(64)}`
    const list = vi.fn(async () => ({
      data: [],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'planned-list' },
    }))
    const replaceForTask = vi.fn(async () => ({
      data: { attributes: { state: 'pending' }, id: 'planned-operation-1' },
    }))
    const wait = vi.fn(async () => ({
      data: { attributes: { state: 'succeeded' }, id: 'planned-operation-1' },
    }))
    const dependencies = {
      clientFactory: () =>
        ({
          plannedWork: { list, replaceForTask },
          plannedWorkOperations: { wait },
        }) as never,
      configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
      environment: { TEAMGRID_API_TOKEN: token },
      output: capture().stream,
    }
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'planned-work',
          'list',
          '--start',
          '2026-07-19T00:00:00.000Z',
          '--end',
          '2026-07-20T00:00:00.000Z',
          '--user-id',
          'user-1',
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({
      end: '2026-07-20T00:00:00.000Z',
      start: '2026-07-19T00:00:00.000Z',
      userId: 'user-1',
    })
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          'planned-work',
          'replace',
          'task-1',
          '--data',
          '{"dayLoads":[60],"plannedEnd":"2026-07-19T23:59:59.999Z","plannedStart":"2026-07-19T00:00:00.000Z"}',
          '--if-match',
          revision,
          '--idempotency-key',
          'planned-replace-1',
          '--yes',
          '--wait',
        ],
        dependencies,
      ),
    ).toBe(0)
    expect(replaceForTask).toHaveBeenCalledWith(
      'task-1',
      {
        dayLoads: [60],
        plannedEnd: '2026-07-19T23:59:59.999Z',
        plannedStart: '2026-07-19T00:00:00.000Z',
      },
      { idempotencyKey: 'planned-replace-1', ifMatch: revision },
    )
    expect(wait).toHaveBeenCalledWith('planned-operation-1', {
      maxWaitMs: 300_000,
      pollIntervalMs: 1000,
    })
  })

  it('routes collaboration resources and confirms call-note archives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const list = vi.fn(async () => ({
      data: [],
      meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
    }))
    const archive = vi.fn(async () => undefined)
    const client = { callNotes: { archive, list } }
    expect(
      await runCli(
        ['node', 'teamgrid', '--output', 'json', 'call-notes', 'list', '--archived', 'true'],
        {
          clientFactory: () => client as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: capture().stream,
        },
      ),
    ).toBe(0)
    expect(list).toHaveBeenCalledWith({ archived: true })

    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', 'call-notes', 'archive', 'note-1'], {
        clientFactory: () => client as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        errorOutput: errorOutput.stream,
        input: new PassThrough(),
        output: capture().stream,
      }),
    ).toBe(2)
    expect(archive).not.toHaveBeenCalled()
    expect(errorOutput.value()).toContain('Use --yes')
  })

  it('starts, optionally waits for, and safely confirms project lifecycle operations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-'))
    const pending = {
      attributes: { action: 'complete', state: 'pending' },
      id: 'operation-1',
      type: 'projectLifecycleOperation',
    }
    const succeeded = {
      ...pending,
      attributes: { action: 'complete', state: 'succeeded' },
    }
    const complete = vi.fn(async () => ({ data: pending }))
    const archive = vi.fn(async () => ({ data: { ...pending, id: 'operation-2' } }))
    const wait = vi.fn(async () => ({ data: succeeded }))
    const client = {
      projectLifecycleOperations: { wait },
      projects: { archive, complete },
    }
    const output = capture()
    expect(
      await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          'projects',
          'complete',
          'project-1',
          '--idempotency-key',
          'lifecycle-1',
          '--wait',
          '--poll-interval',
          '250',
          '--max-wait',
          '5000',
        ],
        {
          clientFactory: () => client as never,
          configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
          environment: { TEAMGRID_API_TOKEN: token },
          output: output.stream,
        },
      ),
    ).toBe(0)
    expect(complete).toHaveBeenCalledWith('project-1', { idempotencyKey: 'lifecycle-1' })
    expect(wait).toHaveBeenCalledWith('operation-1', {
      maxWaitMs: 5000,
      pollIntervalMs: 250,
    })
    expect(JSON.parse(output.value()).attributes.state).toBe('succeeded')

    const errorOutput = capture()
    expect(
      await runCli(['node', 'teamgrid', 'projects', 'archive', 'project-1'], {
        clientFactory: () => client as never,
        configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
        environment: { TEAMGRID_API_TOKEN: token },
        errorOutput: errorOutput.stream,
        input: new PassThrough(),
        output: capture().stream,
      }),
    ).toBe(2)
    expect(archive).not.toHaveBeenCalled()
    expect(errorOutput.value()).toContain('Use --yes')
  })
})

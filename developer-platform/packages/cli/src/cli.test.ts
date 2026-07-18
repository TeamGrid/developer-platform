import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { TeamGridClientError } from '@teamgrid/api-client'
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
})

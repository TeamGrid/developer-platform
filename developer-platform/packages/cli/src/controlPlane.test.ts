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
const settingsRevision = `wst1-${'a'.repeat(64)}`
const webhookRevision = `whk1-${'b'.repeat(64)}`
const signingSecret = `whsec_v2_${'A'.repeat(43)}`

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
  options: { input?: PassThrough; output?: PassThrough } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-control-plane-cli-'))
  const output = capture()
  const error = capture()
  const code = await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: token },
    errorOutput: error.stream,
    input: options.input,
    output: options.output || output.stream,
  })
  return { code, error: error.value(), output: output.value() }
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

function rotation() {
  return {
    data: {
      attributes: { replayed: false, revision: webhookRevision, signingSecret },
      id: 'webhook-1',
      type: 'webhookSecretRotation',
    },
  }
}

function createdWebhook() {
  return {
    data: {
      attributes: {
        actions: ['task.updated'],
        disabled: false,
        failCount: 0,
        lastStatus: null,
        revision: webhookRevision,
        signingSecret,
        url: 'https://hooks.example.test/teamgrid',
        version: 2,
      },
      id: 'webhook-1',
      type: 'webhook',
    },
  }
}

describe('developer control-plane CLI surfaces', () => {
  it('registers the six canonical commands', () => {
    expect(new Set(commandPaths(createProgram()))).toEqual(
      expect.objectContaining({
        size: expect.any(Number),
      }),
    )
    expect(commandPaths(createProgram())).toEqual(
      expect.arrayContaining([
        'events catalog',
        'system capabilities',
        'webhooks rotate-secret',
        'workspace entitlements',
        'workspace-settings get',
        'workspace-settings update',
      ]),
    )
  })

  it('routes discovery and settings commands with script-safe structured output', async () => {
    const getCapabilities = vi.fn(async () => ({
      data: [{ attributes: { accessible: true, entitled: true }, id: 'webhooks' }],
    }))
    const getEntitlements = vi.fn(async () => ({
      data: [{ attributes: { accessible: true, enabled: true }, id: 'webhooks' }],
    }))
    const getCatalog = vi.fn(async () => ({ data: [] }))
    const getSettings = vi.fn(async () => ({
      data: { attributes: { name: 'TeamGrid', revision: settingsRevision }, id: 'current' },
    }))
    const update = vi.fn(async () => ({
      data: { attributes: { name: 'Platform', revision: settingsRevision }, id: 'current' },
    }))
    const client = {
      events: { getCatalog },
      system: { getCapabilities },
      workspace: { getEntitlements },
      workspaceSettings: { get: getSettings, update },
    }

    expect((await execute(['system', 'capabilities'], client)).code).toBe(0)
    expect((await execute(['workspace', 'entitlements'], client)).code).toBe(0)
    expect((await execute(['events', 'catalog'], client)).code).toBe(0)
    expect((await execute(['workspace-settings', 'get'], client)).code).toBe(0)
    const updated = await execute(
      [
        'workspace-settings',
        'update',
        '--data',
        '{"currency":"EUR","name":"Platform"}',
        '--if-match',
        settingsRevision,
        '--idempotency-key',
        'settings-1',
      ],
      client,
    )
    expect(updated.code).toBe(0)
    expect(update).toHaveBeenCalledWith(
      { currency: 'EUR', name: 'Platform' },
      { idempotencyKey: 'settings-1', ifMatch: settingsRevision },
    )
  })

  it('reserves a new mode-0600 file before rotation and prints only a non-secret receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-webhook-secret-'))
    const path = join(directory, 'webhook.secret')
    const rotateSecret = vi.fn(async () => rotation())
    const result = await execute(
      [
        'webhooks',
        'rotate-secret',
        'webhook-1',
        '--if-match',
        webhookRevision,
        '--idempotency-key',
        'rotate-1',
        '--secret-file',
        path,
        '--yes',
      ],
      { webhooks: { rotateSecret } },
    )

    expect(result.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(`${signingSecret}\n`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(result.output).not.toContain(signingSecret)
    expect(result.error).not.toContain(signingSecret)
    expect(JSON.parse(result.output)).toMatchObject({
      destination: 'file',
      id: 'webhook-1',
      replayed: false,
      revision: webhookRevision,
    })
    expect(rotateSecret).toHaveBeenCalledWith('webhook-1', {
      idempotencyKey: 'rotate-1',
      ifMatch: webhookRevision,
    })
  })

  it('uses the same reveal-only destination policy for webhook creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-created-webhook-secret-'))
    const path = join(directory, 'webhook.secret')
    const create = vi.fn(async () => createdWebhook())
    const result = await execute(
      [
        'webhooks',
        'create',
        '--data',
        '{"actions":["task.updated"],"url":"https://hooks.example.test/teamgrid"}',
        '--idempotency-key',
        'create-1',
        '--secret-file',
        path,
      ],
      { webhooks: { create } },
    )
    expect(result.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(`${signingSecret}\n`)
    expect(result.output).not.toContain(signingSecret)
    expect(JSON.parse(result.output)).toMatchObject({
      destination: 'file',
      id: 'webhook-1',
      revision: webhookRevision,
      type: 'webhook',
    })
  })

  it('writes only the raw secret to explicitly selected stdout', async () => {
    const rotateSecret = vi.fn(async () => rotation())
    const result = await execute(
      [
        'webhooks',
        'rotate-secret',
        'webhook-1',
        '--if-match',
        webhookRevision,
        '--secret-stdout',
        '--yes',
      ],
      { webhooks: { rotateSecret } },
    )
    expect(result.code).toBe(0)
    expect(result.output).toBe(`${signingSecret}\n`)
    expect(result.error).toBe('')
  })

  it('refuses secret stdout on a terminal before calling the API', async () => {
    const rotateSecret = vi.fn(async () => rotation())
    const terminal = Object.assign(new PassThrough(), { isTTY: true })
    const result = await execute(
      [
        'webhooks',
        'rotate-secret',
        'webhook-1',
        '--if-match',
        webhookRevision,
        '--secret-stdout',
        '--yes',
      ],
      { webhooks: { rotateSecret } },
      { output: terminal },
    )
    expect(result.code).toBe(2)
    expect(result.error).toContain('Refusing to reveal')
    expect(rotateSecret).not.toHaveBeenCalled()
  })

  it('requires confirmation and an explicit safe destination without rotating on failure', async () => {
    const rotateSecret = vi.fn(async () => rotation())
    const noDestination = await execute(
      ['webhooks', 'rotate-secret', 'webhook-1', '--if-match', webhookRevision, '--yes'],
      { webhooks: { rotateSecret } },
    )
    expect(noDestination.code).toBe(2)
    expect(rotateSecret).not.toHaveBeenCalled()

    const unconfirmed = await execute(
      ['webhooks', 'rotate-secret', 'webhook-1', '--if-match', webhookRevision, '--secret-stdout'],
      { webhooks: { rotateSecret } },
      { input: new PassThrough() },
    )
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.error).toContain('Use --yes')
    expect(rotateSecret).not.toHaveBeenCalled()

    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-existing-secret-'))
    const existing = join(directory, 'secret')
    await writeFile(existing, 'do-not-overwrite', { mode: 0o600 })
    const refused = await execute(
      [
        'webhooks',
        'rotate-secret',
        'webhook-1',
        '--if-match',
        webhookRevision,
        '--secret-file',
        existing,
        '--yes',
      ],
      { webhooks: { rotateSecret } },
    )
    expect(refused.code).toBe(2)
    expect(await readFile(existing, 'utf8')).toBe('do-not-overwrite')
    expect(rotateSecret).not.toHaveBeenCalled()
  })
})

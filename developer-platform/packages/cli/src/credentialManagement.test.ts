import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './config.js'
import { createProgram } from './program.js'
import { runCli } from './run.js'

const authToken =
  // gitleaks:allow -- synthetic fixed-format test credential
  `tg_pat_v2_de_de-nbg-001_${'0'.repeat(24)}_${'1'.repeat(64)}`
const personalToken =
  // gitleaks:allow -- synthetic fixed-format test credential
  `tg_pat_v2_de_de-nbg-001_${'a'.repeat(24)}_${'b'.repeat(64)}`
const serviceToken =
  // gitleaks:allow -- synthetic fixed-format test credential
  `tg_sa_v2_de_de-nbg-001_${'c'.repeat(24)}_${'d'.repeat(64)}`

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
  outputOverride?: PassThrough & { isTTY?: boolean },
) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-credential-cli-'))
  const output = capture()
  const error = capture()
  const code = await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: authToken },
    errorOutput: error.stream,
    input: new PassThrough(),
    output: outputOverride || output.stream,
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

function reveal(
  type: 'personalAccessToken' | 'serviceAccountCredential',
  token = type === 'personalAccessToken' ? personalToken : serviceToken,
) {
  return {
    data: {
      attributes: {
        generation: 1,
        principalId:
          type === 'personalAccessToken' ? `pat:${'a'.repeat(24)}` : `sa:${'e'.repeat(24)}`,
        token,
      },
      id: type === 'personalAccessToken' ? 'a'.repeat(24) : 'c'.repeat(24),
      type,
    },
  }
}

describe('credential management CLI', () => {
  it('registers every canonical credential and service-account command', () => {
    expect(commandPaths(createProgram())).toEqual(
      expect.arrayContaining([
        'credentials personal list',
        'credentials personal create',
        'credentials personal rotate',
        'credentials personal revoke',
        'service-accounts list',
        'service-accounts get',
        'service-accounts create',
        'service-accounts update',
        'service-accounts revoke',
        'service-accounts credentials create',
        'service-accounts credentials rotate',
        'service-accounts credentials revoke',
      ]),
    )
  })

  it('reserves a mode-0600 file and never prints a newly created personal token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-personal-token-'))
    const path = join(directory, 'personal.token')
    const create = vi.fn(async () => reveal('personalAccessToken'))
    const result = await execute(
      [
        'credentials',
        'personal',
        'create',
        '--data',
        '{"name":"Automation","scopes":["credentials:read"]}',
        '--idempotency-key',
        'personal-create-1',
        '--secret-file',
        path,
      ],
      { personalAccessTokens: { create } },
    )

    expect(result.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(`${personalToken}\n`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(result.output).not.toContain(personalToken)
    expect(result.error).not.toContain(personalToken)
    expect(create).toHaveBeenCalledWith(
      { name: 'Automation', scopes: ['credentials:read'] },
      { idempotencyKey: 'personal-create-1' },
    )
  })

  it('refuses terminal output and existing files before issuing a credential', async () => {
    const create = vi.fn(async () => reveal('serviceAccountCredential'))
    const terminal = Object.assign(new PassThrough(), { isTTY: true })
    const terminalResult = await execute(
      [
        'service-accounts',
        'create',
        '--data',
        '{"name":"ERP","scopes":["projects:read"]}',
        '--secret-stdout',
      ],
      { serviceAccounts: { create } },
      terminal,
    )
    expect(terminalResult.code).toBe(2)
    expect(create).not.toHaveBeenCalled()

    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-existing-token-'))
    const path = join(directory, 'service.token')
    await writeFile(path, 'keep-me', { mode: 0o600 })
    const fileResult = await execute(
      [
        'service-accounts',
        'create',
        '--data',
        '{"name":"ERP","scopes":["projects:read"]}',
        '--secret-file',
        path,
      ],
      { serviceAccounts: { create } },
    )
    expect(fileResult.code).toBe(2)
    expect(await readFile(path, 'utf8')).toBe('keep-me')
    expect(create).not.toHaveBeenCalled()
  })

  it('routes independent service credential rotation and revocation safely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-service-token-'))
    const path = join(directory, 'rotated.token')
    const rotateCredential = vi.fn(async () => reveal('serviceAccountCredential'))
    const revokeCredential = vi.fn(async () => ({ status: 204 }))
    const serviceAccountId = 'e'.repeat(24)
    const credentialId = 'c'.repeat(24)
    const rotated = await execute(
      [
        'service-accounts',
        'credentials',
        'rotate',
        serviceAccountId,
        credentialId,
        '--data',
        '{"gracePeriodSeconds":300,"scopes":["projects:read"]}',
        '--idempotency-key',
        'service-rotate-1',
        '--secret-file',
        path,
        '--yes',
      ],
      { serviceAccounts: { rotateCredential } },
    )
    expect(rotated.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(`${serviceToken}\n`)
    expect(rotateCredential).toHaveBeenCalledWith(
      serviceAccountId,
      credentialId,
      { gracePeriodSeconds: 300, scopes: ['projects:read'] },
      { idempotencyKey: 'service-rotate-1' },
    )

    const revoked = await execute(
      ['service-accounts', 'credentials', 'revoke', serviceAccountId, credentialId, '--yes'],
      { serviceAccounts: { revokeCredential } },
    )
    expect(revoked.code).toBe(0)
    expect(revokeCredential).toHaveBeenCalledWith(serviceAccountId, credentialId)
  })

  it('validates credential input locally before issuing a secret', async () => {
    const create = vi.fn(async () => reveal('personalAccessToken'))
    const result = await execute(
      [
        'credentials',
        'personal',
        'create',
        '--data',
        '{"name":"Automation","scopes":["not-a-public-scope"]}',
        '--secret-stdout',
      ],
      { personalAccessTokens: { create } },
    )
    expect(result.code).toBe(2)
    expect(result.error).toContain('1–100 unique public scopes')
    expect(create).not.toHaveBeenCalled()
  })
})

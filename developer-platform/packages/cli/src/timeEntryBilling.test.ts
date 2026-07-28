import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './config.js'
import { runCli } from './run.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_de_de-nbg-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const revision = `tib1-${'a'.repeat(64)}`

function capture() {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    value += chunk
  })
  return { stream, value: () => value }
}

async function execute(args: string[], client: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-billing-'))
  const output = capture()
  const error = capture()
  const code = await runCli(['node', 'teamgrid', '--output', 'json', ...args], {
    clientFactory: () => client as never,
    configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
    environment: { TEAMGRID_API_TOKEN: token },
    errorOutput: error.stream,
    output: output.stream,
  })
  return { code, error: error.value(), output: output.value() }
}

describe('time-entry billing CLI', () => {
  it('uses an explicit latest revision for a safe billing update', async () => {
    const getBilling = vi.fn(async () => ({
      data: {
        attributes: { billed: false, billedAt: null, revision },
        id: 'time-1',
        type: 'timeEntryBilling',
      },
    }))
    const updateBilling = vi.fn(async () => ({
      data: {
        attributes: {
          billed: true,
          billedAt: '2026-07-27T12:00:00.000Z',
          revision: `tib1-${'b'.repeat(64)}`,
        },
        id: 'time-1',
        type: 'timeEntryBilling',
      },
    }))
    const result = await execute(
      ['time-entries', 'billing', 'update', 'time-1', '--billed', '--if-match', revision],
      { timeEntries: { getBilling, updateBilling } },
    )
    expect(result.code).toBe(0)
    expect(getBilling).not.toHaveBeenCalled()
    expect(updateBilling).toHaveBeenCalledWith('time-1', { billed: true }, { ifMatch: revision })
  })

  it('accepts an explicit revision and rejects ambiguous state', async () => {
    const getBilling = vi.fn()
    const updateBilling = vi.fn(async () => ({
      data: {
        attributes: { billed: false, billedAt: null, revision },
        id: 'time-1',
        type: 'timeEntryBilling',
      },
    }))
    const explicit = await execute(
      ['time-entries', 'billing', 'update', 'time-1', '--unbilled', '--if-match', revision],
      { timeEntries: { getBilling, updateBilling } },
    )
    expect(explicit.code).toBe(0)
    expect(getBilling).not.toHaveBeenCalled()
    expect(updateBilling).toHaveBeenCalledWith('time-1', { billed: false }, { ifMatch: revision })

    const ambiguous = await execute(
      [
        'time-entries',
        'billing',
        'update',
        'time-1',
        '--billed',
        '--unbilled',
        '--if-match',
        revision,
      ],
      { timeEntries: { getBilling, updateBilling } },
    )
    expect(ambiguous.code).toBe(2)
    expect(ambiguous.error).toContain('Choose exactly one billing state')
  })
})

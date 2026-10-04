import { describe, expect, it } from 'vitest'
import {
  createMongoOAuthRoutingDirectory,
  type OAuthRoutingRecord,
  oauthRoutingRecordId,
} from './oauthRoutingDirectory.js'

const issuer = 'https://mcp.example.test/'
const resource = `${issuer}mcp`
const time = new Date('2026-10-05T00:00:00Z')
const signal = () => new AbortController().signal
function record(
  kind: 'code' | 'access' | 'refresh' = 'access',
  hash = 'a'.repeat(64),
): OAuthRoutingRecord {
  return {
    _id: oauthRoutingRecordId(issuer, resource, kind, hash),
    issuer,
    resource,
    region: 'de',
    cellId: 'de-test',
    kind,
    hash,
    registrationId: 'b'.repeat(64),
    createdAt: time,
    expiresAt: new Date(+time + 86400000),
  }
}
function harness() {
  const rows = new Map<string, OAuthRoutingRecord>()
  const calls: { method: string; options: Record<string, unknown> }[] = []
  let failWrite = 0
  let clock = time
  const collection = {
    async createIndex(_keys: unknown, options: Record<string, unknown>) {
      calls.push({ method: 'index', options })
    },
    async findOne(filter: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push({ method: 'read', options })
      return structuredClone(rows.get(filter._id as string) ?? null)
    },
    async updateOne(
      filter: Record<string, unknown>,
      _update: unknown,
      options: Record<string, unknown>,
    ) {
      calls.push({ method: 'write', options })
      if (failWrite && calls.filter((call) => call.method === 'write').length === failWrite)
        throw new Error('Write outage')
      const old = rows.get(filter._id as string)
      if (old && JSON.stringify(old) !== JSON.stringify(filter)) throw new Error('Duplicate key')
      rows.set(filter._id as string, structuredClone(filter) as OAuthRoutingRecord)
    },
  }
  const directory = createMongoOAuthRoutingDirectory({
    issuer,
    resource,
    cells: [
      { cellId: 'de-test', region: 'de' },
      { cellId: 'us-test', region: 'us' },
    ],
    collection,
    now: () => clock,
  })
  return {
    directory,
    collection,
    rows,
    calls,
    fail: (write: number) => {
      failWrite = write
    },
    clock: (value: Date) => {
      clock = value
    },
  }
}

describe('Mongo OAuth routing directory', () => {
  it('requires initialization, journaled majority publication and primary linearizable reads', async () => {
    const h = harness()
    await expect(h.directory.resolve('access', 'a'.repeat(64), signal())).rejects.toThrow(
      'initialized',
    )
    await h.directory.initialize(signal())
    await h.directory.register([record()], signal())
    expect(await h.directory.resolve('access', 'a'.repeat(64), signal())).toBe('de-test')
    expect(h.calls.find((call) => call.method === 'write')?.options).toMatchObject({
      upsert: true,
      writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 },
      maxTimeMS: 5000,
    })
    expect(h.calls.find((call) => call.method === 'read')?.options).toMatchObject({
      readPreference: 'primary',
      readConcern: { level: 'linearizable' },
      maxTimeMS: 5000,
    })
  })
  it('retains exact registrations and never overwrites a cell, generation or deadline', async () => {
    const h = harness()
    await h.directory.initialize(signal())
    const route = record()
    await h.directory.register([route], signal())
    await h.directory.register([route], signal())
    for (const patch of [
      { region: 'us', cellId: 'us-test' },
      { registrationId: 'c'.repeat(64) },
      { expiresAt: new Date(+time + 2 * 86400000) },
    ]) {
      await expect(h.directory.register([{ ...route, ...patch }], signal())).rejects.toThrow(
        'unavailable',
      )
    }
    expect(h.rows.get(route._id)).toEqual(route)
  })
  it('resumes partial publication without replacing the first route', async () => {
    const h = harness()
    await h.directory.initialize(signal())
    h.fail(2)
    const routes = [record('access'), record('refresh', 'c'.repeat(64))]
    await expect(h.directory.register(routes, signal())).rejects.toThrow('unavailable')
    expect(h.rows.size).toBe(1)
    h.fail(0)
    await h.directory.register(routes, signal())
    expect(h.rows.size).toBe(2)
  })
  it('checks logical authority, closed cells, credential kind, hash and retention', async () => {
    const h = harness()
    await h.directory.initialize(signal())
    for (const patch of [
      { issuer: 'https://evil.example.test/' },
      { resource: `${resource}/other` },
      { region: 'us' },
      { cellId: 'unknown' },
      { hash: 'wrong' },
      { _id: 'c'.repeat(64) },
      { expiresAt: new Date(+time + 32 * 86400000) },
      { providerUrl: 'https://evil.example.test/' },
    ]) {
      await expect(h.directory.register([{ ...record(), ...patch }], signal())).rejects.toThrow()
    }
    await h.directory.register([record()], signal())
    expect(await h.directory.resolve('refresh', 'a'.repeat(64), signal())).toBeNull()
    h.clock(new Date(+time + 86400000))
    expect(await h.directory.resolve('access', 'a'.repeat(64), signal())).toBeNull()
  })
  it('rejects corrupt stored records and outages rather than supplying a missing route', async () => {
    const h = harness()
    await h.directory.initialize(signal())
    const route = record()
    h.rows.set(route._id, { ...route, region: 'us' })
    await expect(h.directory.resolve('access', route.hash, signal())).rejects.toThrow()
    h.collection.findOne = async () => {
      throw new Error('Secret database address')
    }
    await expect(h.directory.resolve('access', route.hash, signal())).rejects.toThrow(
      'directory unavailable',
    )
  })
  it('bounds even an uncooperative backend through the request signal', async () => {
    const h = harness()
    await h.directory.initialize(signal())
    h.collection.findOne = () => new Promise(() => {})
    await expect(
      h.directory.resolve('access', 'a'.repeat(64), AbortSignal.timeout(20)),
    ).rejects.toThrow('unavailable')
  })
})

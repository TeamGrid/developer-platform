import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withinSignal } from './http.js'
import type { MongoOAuthRoutingCollection } from './oauthRoutingDirectory.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
export const oauthBrowserRecordSchema = z
  .object({
    _id: hash,
    issuer: z.string(),
    resource: z.string(),
    browserHash: hash,
    clientRecordId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    clientId: z.string().min(1).max(2048),
    clientName: z.string().min(1).max(160),
    redirectUri: z.string().max(2048),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    scopes: z.array(z.string().min(1).max(128)).min(1).max(100),
    nonce: z
      .string()
      .regex(/^[\x20-\x7e]{1,256}$/)
      .optional(),
    state: z.string().max(2048).optional(),
    createdAt: z.date(),
    expiresAt: z.date(),
    status: z.enum(['selecting', 'selected', 'prepared', 'completed']),
    selection: z
      .object({
        cellId: name,
        region: name,
        workspaceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
        workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        ticketHash: hash,
      })
      .strict()
      .optional(),
    completion: z
      .object({ codeHash: hash.optional(), denied: z.boolean(), at: z.date() })
      .strict()
      .optional(),
  })
  .strict()
export type OAuthBrowserRecord = z.infer<typeof oauthBrowserRecordSchema>
export type OAuthBrowserStore = {
  insert(record: OAuthBrowserRecord, signal: AbortSignal): Promise<void>
  read(id: string, signal: AbortSignal): Promise<OAuthBrowserRecord | null>
  transition(
    before: OAuthBrowserRecord,
    after: OAuthBrowserRecord,
    signal: AbortSignal,
  ): Promise<boolean>
}

export const oauthBrowserHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const OAUTH_BROWSER_TTL_MS = 600000

/** Native replica-set storage; cookies, selection tickets and authorization codes remain hashed. */
export function createMongoOAuthBrowserStore(options: {
  issuer: string
  resource: string
  cells: readonly { cellId: string; region: string }[]
  collection: MongoOAuthRoutingCollection & {
    insertOne(record: unknown, options: Record<string, unknown>): Promise<unknown>
  }
  now?: () => Date
}) {
  for (const value of [options.issuer, options.resource]) {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value
    )
      throw new Error('Invalid OAuth browser authority.')
  }
  const cells = new Map(
    options.cells.map((cell) => [name.parse(cell.cellId), name.parse(cell.region)]),
  )
  if (
    new URL(options.issuer).pathname !== '/' ||
    cells.size < 1 ||
    cells.size > 16 ||
    cells.size !== options.cells.length
  )
    throw new Error('Invalid OAuth browser cells.')
  const now = options.now ?? (() => new Date())
  const writeConcern = { w: 'majority', j: true, wtimeoutMS: 5000 }
  let ready = false
  const validate = (value: unknown) => {
    const record = oauthBrowserRecordSchema.parse(structuredClone(value))
    if (
      record.issuer !== options.issuer ||
      record.resource !== options.resource ||
      +record.expiresAt <= +record.createdAt ||
      +record.expiresAt > +record.createdAt + OAUTH_BROWSER_TTL_MS ||
      !record.scopes.includes('workspace:read') ||
      new Set(record.scopes).size !== record.scopes.length ||
      (record.scopes.includes('email') && !record.scopes.includes('openid')) ||
      (record.nonce !== undefined && !record.scopes.includes('openid')) ||
      (record.status === 'selecting') !== (record.selection === undefined) ||
      (record.status === 'completed') !== (record.completion !== undefined) ||
      (record.selection && cells.get(record.selection.cellId) !== record.selection.region) ||
      (record.completion &&
        (record.completion.denied === Boolean(record.completion.codeHash) ||
          +record.completion.at < +record.createdAt ||
          +record.completion.at >= +record.expiresAt))
    ) {
      throw new Error('Invalid OAuth browser record.')
    }
    return record
  }
  const live = (record: OAuthBrowserRecord) => {
    const time = +now()
    if (!Number.isFinite(time) || +record.createdAt > time)
      throw new Error('OAuth browser clock unavailable.')
    return time < +record.expiresAt
  }
  const bounded = async <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])
    deadline.throwIfAborted()
    return withinSignal(action(deadline), deadline)
  }
  return {
    async initialize(signal: AbortSignal) {
      await bounded(signal, (operationSignal) =>
        options.collection.createIndex(
          { expiresAt: 1 },
          {
            name: 'oauth_browser_retention',
            expireAfterSeconds: 0,
            writeConcern,
            maxTimeMS: 5000,
            signal: operationSignal,
          },
        ),
      )
      ready = true
    },
    async insert(value: OAuthBrowserRecord, signal: AbortSignal) {
      if (!ready) throw new Error('OAuth browser store not initialized.')
      const record = validate(value)
      if (record.status !== 'selecting' || !live(record))
        throw new Error('Invalid initial OAuth browser record.')
      await bounded(signal, (operationSignal) =>
        options.collection.insertOne(record, {
          writeConcern,
          maxTimeMS: 5000,
          signal: operationSignal,
        }),
      )
    },
    async read(id: string, signal: AbortSignal) {
      if (!ready) throw new Error('OAuth browser store not initialized.')
      hash.parse(id)
      const stored = await bounded(signal, (operationSignal) =>
        options.collection.findOne(
          { _id: id },
          {
            readPreference: 'primary',
            readConcern: { level: 'linearizable' },
            maxTimeMS: 5000,
            signal: operationSignal,
          },
        ),
      )
      if (stored === null) return null
      const record = validate(stored)
      if (record._id !== id) throw new Error('Invalid OAuth browser identity.')
      return live(record) ? record : null
    },
    async transition(previous: OAuthBrowserRecord, next: OAuthBrowserRecord, signal: AbortSignal) {
      if (!ready) throw new Error('OAuth browser store not initialized.')
      const before = validate(previous),
        after = validate(next)
      const immutable = (record: OAuthBrowserRecord) => {
        const {
          status: _status,
          selection: _selection,
          completion: _completion,
          ...identity
        } = record
        return JSON.stringify(identity)
      }
      const transitions = {
        selecting: 'selected',
        selected: 'prepared',
        prepared: 'completed',
        completed: '',
      }
      if (
        !live(before) ||
        !live(after) ||
        immutable(before) !== immutable(after) ||
        transitions[before.status] !== after.status ||
        (before.selection && JSON.stringify(before.selection) !== JSON.stringify(after.selection))
      ) {
        throw new Error('Invalid OAuth browser transition.')
      }
      const result = await bounded(signal, (operationSignal) =>
        options.collection.updateOne(
          before,
          {
            $set: after,
          },
          { writeConcern, maxTimeMS: 5000, signal: operationSignal },
        ),
      )
      if (
        !result ||
        typeof result !== 'object' ||
        !('modifiedCount' in result) ||
        ![0, 1].includes(Number(result.modifiedCount))
      )
        throw new Error('OAuth browser write unavailable.')
      return result.modifiedCount === 1
    },
  }
}

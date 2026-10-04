import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withinSignal } from './http.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const cellName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
export const oauthRoutingRecordSchema = z
  .object({
    _id: hash,
    issuer: z.string(),
    resource: z.string(),
    region: cellName,
    cellId: cellName,
    kind: z.enum(['code', 'access', 'refresh']),
    hash,
    registrationId: hash,
    createdAt: z.date(),
    expiresAt: z.date(),
  })
  .strict()
export type OAuthRoutingRecord = z.infer<typeof oauthRoutingRecordSchema>
export type OAuthCredentialKind = OAuthRoutingRecord['kind']

/** Supply a native MongoDB collection from a replica set, not a cache or a Meteor wrapper. */
export type MongoOAuthRoutingCollection = {
  findOne(filter: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>
  createIndex(keys: Record<string, number>, options: Record<string, unknown>): Promise<unknown>
}
export type OAuthRoutingDirectory = {
  resolve(
    kind: OAuthCredentialKind,
    credentialHash: string,
    signal: AbortSignal,
  ): Promise<string | null>
  register(records: readonly OAuthRoutingRecord[], signal: AbortSignal): Promise<void>
}

function canonicalHttps(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new Error('Invalid OAuth routing authority.')
  return url
}
export function oauthRoutingRecordId(
  issuer: string,
  resource: string,
  kind: OAuthCredentialKind,
  credentialHash: string,
) {
  return createHash('sha256')
    .update(JSON.stringify([issuer, resource, kind, credentialHash]))
    .digest('hex')
}

/** Immutable hash mappings; majority+journaled publication and bounded linearizable reads. */
export function createMongoOAuthRoutingDirectory(options: {
  issuer: string
  resource: string
  cells: readonly { cellId: string; region: string }[]
  collection: MongoOAuthRoutingCollection
  now?: () => Date
}) {
  if (
    canonicalHttps(options.issuer).pathname !== '/' ||
    !canonicalHttps(options.resource) ||
    options.cells.length < 1 ||
    options.cells.length > 16
  ) {
    throw new Error('Invalid OAuth routing directory configuration.')
  }
  const cells = new Map(
    options.cells.map((cell) => [cellName.parse(cell.cellId), cellName.parse(cell.region)]),
  )
  if (cells.size !== options.cells.length) throw new Error('Duplicate OAuth routing cell.')
  const authority = { issuer: options.issuer, resource: options.resource }
  const now = options.now ?? (() => new Date())
  let ready = false
  const writeConcern = { w: 'majority', j: true, wtimeoutMS: 5000 }
  const id = (kind: OAuthCredentialKind, credentialHash: string) => {
    z.enum(['code', 'access', 'refresh']).parse(kind)
    hash.parse(credentialHash)
    return oauthRoutingRecordId(authority.issuer, authority.resource, kind, credentialHash)
  }
  const bounded = async <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])
    deadline.throwIfAborted()
    try {
      return await withinSignal(action(deadline), deadline)
    } catch {
      throw new Error('OAuth routing directory unavailable.')
    }
  }
  function validate(value: unknown) {
    const record = oauthRoutingRecordSchema.parse(value)
    if (
      record.issuer !== authority.issuer ||
      record.resource !== authority.resource ||
      cells.get(record.cellId) !== record.region ||
      record._id !== id(record.kind, record.hash) ||
      +record.expiresAt <= +record.createdAt ||
      +record.expiresAt > +record.createdAt + 31 * 86400000
    ) {
      throw new Error('Invalid OAuth routing record.')
    }
    return record
  }
  return {
    async initialize(signal: AbortSignal) {
      await bounded(signal, (operationSignal) =>
        options.collection.createIndex(
          { expiresAt: 1 },
          {
            name: 'oauth_routing_retention',
            expireAfterSeconds: 0,
            writeConcern,
            maxTimeMS: 5000,
            signal: operationSignal,
          },
        ),
      )
      ready = true
    },
    async resolve(kind: OAuthCredentialKind, credentialHash: string, signal: AbortSignal) {
      if (!ready) throw new Error('OAuth routing directory not initialized.')
      const key = id(kind, credentialHash)
      const stored = await bounded(signal, (operationSignal) =>
        options.collection.findOne(
          { _id: key },
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
      const time = +now()
      if (!Number.isFinite(time)) throw new Error('OAuth routing clock unavailable.')
      if (record.kind !== kind || record.hash !== credentialHash || +record.createdAt > time) {
        throw new Error('Invalid OAuth routing record.')
      }
      return +record.expiresAt > time ? record.cellId : null
    },
    async register(values: readonly OAuthRoutingRecord[], signal: AbortSignal) {
      if (!ready) throw new Error('OAuth routing directory not initialized.')
      if (!Array.isArray(values) || values.length < 1 || values.length > 2) {
        throw new Error('Invalid OAuth routing publication.')
      }
      // Copy all input before the first await; a provider cannot mutate a later record.
      const records = values.map((value) => validate(structuredClone(value)))
      const time = +now()
      if (
        !Number.isFinite(time) ||
        records.some((record) => +record.createdAt > time || +record.expiresAt <= time) ||
        new Set(records.map((record) => record._id)).size !== records.length
      ) {
        throw new Error('Invalid OAuth routing publication.')
      }
      for (const record of records) {
        // Exact existing records are idempotent. Any differing immutable field
        // attempts an insert with the existing _id and fails, rather than overwriting it.
        await bounded(signal, (operationSignal) =>
          options.collection.updateOne(
            record,
            {
              $setOnInsert: record,
            },
            { upsert: true, writeConcern, maxTimeMS: 5000, signal: operationSignal },
          ),
        )
      }
    },
  }
}

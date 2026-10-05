import { createHash, createHmac } from 'node:crypto'
import { underSignal } from './io.mjs'

export const writeConcern = { w: 'majority', j: true, wtimeoutMS: 5000 }
export const ttlIndex = { key: { expiresAt: 1 }, expireAfterSeconds: 0 }

/** Shared fixed-window quotas. Only HMAC identities and short-lived counters are persisted. */
export function createMongoAdmission({ collection, issuer, resource, policy, now = Date.now }) {
  let initialized = false
  const authority = JSON.stringify([issuer, resource])
  return {
    async initialize(signal) {
      await underSignal(
        collection.createIndex(ttlIndex.key, {
          name: 'federation_admission_retention',
          expireAfterSeconds: 0,
          writeConcern,
          maxTimeMS: 5000,
          signal,
        }),
        signal,
      )
      initialized = true
    },
    async admit(request) {
      if (!initialized) throw new Error('Federated admission not initialized.')
      const time = now()
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('Federated clock unavailable.')
      const window = Math.floor(time / 60000)
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)])
      const authorization = request.headers.get('authorization')
      const credential =
        new URL(request.url).pathname === '/mcp' &&
        /^Bearer tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/i.test(authorization ?? '')
      const identity = credential
        ? createHmac('sha256', policy.hmacSecret).update(authorization).digest('hex')
        : 'public'
      const buckets = [
        ['all', policy.globalPerMinute],
        [identity, credential ? policy.credentialPerMinute : policy.publicPerMinute],
      ]
      for (const [bucket, limit] of buckets) {
        signal.throwIfAborted()
        const _id = createHash('sha256')
          .update(JSON.stringify([authority, window, bucket]))
          .digest('hex')
        const expiresAt = new Date((window + 3) * 60000)
        const value = await underSignal(
          collection.findOneAndUpdate(
            { _id },
            {
              $inc: { count: 1 },
              $setOnInsert: { expiresAt },
            },
            {
              upsert: true,
              returnDocument: 'after',
              includeResultMetadata: false,
              writeConcern,
              maxTimeMS: 5000,
              signal,
            },
          ),
          signal,
        )
        if (
          !value ||
          value._id !== _id ||
          !Number.isSafeInteger(value.count) ||
          value.count < 1 ||
          !(value.expiresAt instanceof Date) ||
          +value.expiresAt !== +expiresAt
        ) {
          throw new Error('Federated admission unavailable.')
        }
        if (value.count > limit) return false
      }
      return true
    },
  }
}

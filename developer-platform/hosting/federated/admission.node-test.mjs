import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMongoAdmission } from './admission.mjs'
import { fixture, memoryCollection } from './fixtureSupport.mjs'

test('shared atomic quotas combine concurrent instances without storing raw credentials', async () => {
  const config = fixture(),
    collection = memoryCollection()
  const options = {
    issuer: config.issuer,
    resource: config.resource,
    collection,
    policy: { ...config.admission, globalPerMinute: 100, credentialPerMinute: 7 },
    now: () => 1000,
  }
  const a = createMongoAdmission(options),
    b = createMongoAdmission(options)
  const token = `tg_mcp_at_v1_${'x'.repeat(43)}`
  const request = () =>
    new Request(config.resource, { headers: { Authorization: `Bearer ${token}` } })
  await Promise.all([
    a.initialize(new AbortController().signal),
    b.initialize(new AbortController().signal),
  ])
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).admit(request())),
  )
  assert.equal(results.filter(Boolean).length, 7)
  assert.equal(collection.rows.size, 2)
  assert.equal(JSON.stringify([...collection.rows]).includes(token), false)
  assert.equal(JSON.stringify([...collection.rows]).includes(config.admission.hmacSecret), false)
  for (const [, , , options] of collection.calls.filter(([kind]) => kind === 'increment')) {
    assert.deepEqual(options.writeConcern, { w: 'majority', j: true, wtimeoutMS: 5000 })
    assert.equal(options.includeResultMetadata, false)
  }
})

test('all public OAuth/discovery traffic shares the public ceiling; total ceiling applies to random credentials', async () => {
  const config = fixture(),
    collection = memoryCollection()
  let now = 1000
  const admission = createMongoAdmission({
    collection,
    issuer: config.issuer,
    resource: config.resource,
    policy: { ...config.admission, globalPerMinute: 3, publicPerMinute: 1 },
    now: () => now,
  })
  await admission.initialize(new AbortController().signal)
  assert.equal(await admission.admit(new Request(`${config.issuer}oauth/token`)), true)
  assert.equal(
    await admission.admit(
      new Request(`${config.issuer}oauth/token`, { headers: { Authorization: 'Basic random' } }),
    ),
    false,
  )
  assert.equal(
    await admission.admit(
      new Request(config.resource, {
        headers: { Authorization: `Bearer tg_mcp_at_v1_${'y'.repeat(43)}` },
      }),
    ),
    true,
  )
  assert.equal(
    await admission.admit(
      new Request(config.resource, {
        headers: { Authorization: `Bearer tg_mcp_at_v1_${'z'.repeat(43)}` },
      }),
    ),
    false,
  )
  now = 60000
  assert.equal(await admission.admit(new Request(config.resource)), true)
  assert.equal(
    [...collection.rows.values()].every((value) => +value.expiresAt >= 180000),
    true,
  )
})

test('uninitialized, failed, tampered or canceled quota operations fail unavailable', async () => {
  const config = fixture(),
    collection = memoryCollection()
  const admission = createMongoAdmission({
    collection,
    issuer: config.issuer,
    resource: config.resource,
    policy: config.admission,
  })
  await assert.rejects(admission.admit(new Request(config.resource)))
  await admission.initialize(new AbortController().signal)
  collection.findOneAndUpdate = async () => ({ _id: 'wrong', count: 1, expiresAt: new Date() })
  await assert.rejects(admission.admit(new Request(config.resource)))
  collection.findOneAndUpdate = async () => {
    throw new Error('Storage unavailable')
  }
  await assert.rejects(admission.admit(new Request(config.resource)))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(admission.admit(new Request(config.resource, { signal: controller.signal })))
})

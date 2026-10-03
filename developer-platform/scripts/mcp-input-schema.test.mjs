import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { compactMcpInputSchema } from './mcp-input-schema.mjs'

function equivalent(schema, cases) {
  const compact = compactMcpInputSchema(schema)
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(schema)))
  const original = new Ajv2020({ strict: true }).compile(schema)
  const factored = new Ajv2020({ strict: true }).compile(compact)
  for (const [value, accepted] of cases) {
    assert.equal(original(value), accepted)
    assert.equal(factored(value), accepted)
  }
  return compact
}

test('compaction preserves required fields, bounds, literal values and existing references', () => {
  const branch = {
    type: 'object', additionalProperties: false,
    description: 'Reviewed nested rule. '.repeat(80),
    required: ['label', 'amount'],
    properties: {
      label: { type: 'string', pattern: '^okay$', minLength: 4 },
      amount: { type: 'integer', minimum: 2, maximum: 9 },
      literal: { enum: [{ $ref: 'literal-value', properties: { type: 'literal-value' } }] },
    },
    default: { label: 'okay', amount: 2, properties: { $ref: 'literal-default' } },
  }
  const schema = {
    type: 'object', additionalProperties: false, required: ['p0', 'p1'],
    properties: Object.fromEntries([
      ...Array.from({ length: 40 }, (_, index) => [`p${index}`, structuredClone(branch)]),
      ['existing', { $ref: '#/$defs/tgInputSchema1' }],
    ]),
    $defs: { tgInputSchema1: { type: 'integer', maximum: 10 } },
  }
  const valid = { p0: { label: 'okay', amount: 2 }, p1: { label: 'okay', amount: 9 } }
  equivalent(schema, [
    [valid, true], [{ ...valid, existing: 10 }, true],
    [{ ...valid, p0: { label: 'okay', amount: 1 } }, false],
    [{ ...valid, p0: { label: 'wrong', amount: 2 } }, false],
    [{ ...valid, p0: { label: 'okay', amount: 2, extra: true } }, false],
    [{ p0: valid.p0 }, false], [{ ...valid, existing: 11 }, false],
    [{ ...valid, p0: { ...valid.p0, literal: branch.properties.literal.enum[0] } }, true],
    [{ ...valid, p0: { ...valid.p0, literal: { $ref: 'different' } } }, false],
  ])
})

test('compaction keeps recursive local references valid', () => {
  const node = {
    type: 'object', additionalProperties: false, required: ['name'],
    description: 'Recursive rule. '.repeat(100),
    properties: { name: { type: 'string', minLength: 1 }, next: { $ref: '#/$defs/node' } },
  }
  const schema = {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, structuredClone(node)])),
    $defs: { node },
  }
  equivalent(schema, [
    [{ p0: { name: 'a', next: { name: 'b' } } }, true],
    [{ p0: { name: 'a', next: { name: '' } } }, false],
    [{ p0: { name: 'a', next: { name: 'b', unknown: true } } }, false],
  ])
})

test('pointers into inline properties remain resolvable', () => {
  const branch = {
    type: 'object', description: 'Inline pointer target. '.repeat(100),
    properties: { amount: { type: 'integer', minimum: 2 } },
  }
  const schema = {
    type: 'object',
    properties: Object.fromEntries([
      ...Array.from({ length: 40 }, (_, i) => [`p${i}`, structuredClone(branch)]),
      ['target', { $ref: '#/properties/p0/properties/amount' }],
    ]),
  }
  const original = new Ajv2020({ strict: true }).compile(schema)
  const factored = new Ajv2020({ strict: true }).compile(compactMcpInputSchema(schema))
  for (const [value, accepted] of [[{ target: 2 }, true], [{ target: 1 }, false]]) {
    assert.equal(original(value), accepted)
    assert.equal(factored(value), accepted)
  }
})

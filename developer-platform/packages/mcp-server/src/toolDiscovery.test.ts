import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { TeamGridClient } from '@teamgrid/api-client'
import { describe, expect, it } from 'vitest'
import { createTeamGridMcpServer } from './server.js'
import { compactOutputSchemaDescriptions } from './toolDiscovery.js'

describe('bounded tool discovery metadata', () => {
  it('retains description fields, schema constraints and literal values', () => {
    const literal = { description: 'Literal record data' }
    const schema = {
      type: 'object',
      description: 'Output documentation',
      additionalProperties: false,
      required: ['description', 'values'],
      properties: {
        description: { type: 'string', minLength: 1, description: 'Field documentation' },
        values: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/Value', description: 'Item documentation' },
        },
      },
      $defs: {
        Value: {
          description: 'Definition documentation',
          anyOf: [
            { const: literal, description: 'Constant documentation' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['default'],
              properties: {
                default: {
                  type: 'object',
                  description: 'A field named default',
                  default: literal,
                  enum: [literal],
                  examples: [literal],
                },
              },
            },
          ],
        },
      },
    }
    const before = structuredClone(schema)
    expect(compactOutputSchemaDescriptions(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['description', 'values'],
      properties: {
        description: { type: 'string', minLength: 1 },
        values: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Value' } },
      },
      $defs: {
        Value: {
          anyOf: [
            { const: literal },
            {
              type: 'object',
              additionalProperties: false,
              required: ['default'],
              properties: {
                default: { type: 'object', default: literal, enum: [literal], examples: [literal] },
              },
            },
          ],
        },
      },
    })
    expect(schema).toEqual(before)
  })

  it('preserves boolean schemas and legacy tuple schema constraints', () => {
    expect(compactOutputSchemaDescriptions(false)).toBe(false)
    expect(
      compactOutputSchemaDescriptions({
        type: 'array',
        items: [{ type: 'string', description: 'Tuple item' }, false],
        prefixItems: [{ type: 'integer', minimum: 0, description: 'Prefix item' }],
        contains: { type: 'number', description: 'Contained item' },
        dependentSchemas: {
          value: { required: ['other'], description: 'Conditional documentation' },
        },
      }),
    ).toEqual({
      type: 'array',
      items: [{ type: 'string' }, false],
      prefixItems: [{ type: 'integer', minimum: 0 }],
      contains: { type: 'number' },
      dependentSchemas: { value: { required: ['other'] } },
    })
  })

  it('publishes all 208 tools within the verified discovery metadata budget', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = serveStdio(
      () => createTeamGridMcpServer({} as TeamGridClient, { toolProfile: 'full' }),
      { transport: serverTransport },
    )
    const client = new Client({ name: 'full-discovery-test', version: '1.0.0' })
    try {
      await client.connect(clientTransport)
      const tools = (await client.listTools()).tools
      expect(tools).toHaveLength(208)
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(208)
      // Internal regression budget established by the successful native full
      // catalog probe; this does not assert a documented vendor byte limit.
      expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(1_800_000)
      expect(tools.find((tool) => tool.name === 'teamgrid_task_update')).toMatchObject({
        inputSchema: {
          properties: {
            workspaceId: { description: expect.any(String) },
            expectedRevision: { description: expect.any(String) },
          },
        },
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

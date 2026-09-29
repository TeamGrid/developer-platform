import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { Ajv, addFormats } from '@modelcontextprotocol/server/validators/ajv'
import { type TeamGridClient, TeamGridClientError } from '@teamgrid/api-client'
import generatedCatalog from './generated/domainCatalog.json' with { type: 'json' }
import { type DomainToolName, domainDispatch, domainToolNames } from './generated/domainDispatch.js'
import type { RegisterTeamGridTool } from './registration.js'

type DomainDefinition = {
  operationId: string
  sdk: string
  method: string
  path: string
  domain: string
  write: boolean
  concurrency: string
  idempotency: boolean
  coreCas: boolean
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required: string[]
    [key: string]: unknown
  }
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}
// Keep the public declaration bounded instead of serializing every JSON schema
// a second time into an inferred megabyte-scale .d.ts file.
const catalog: Readonly<Record<DomainToolName, DomainDefinition>> = generatedCatalog
export const domainCatalog: Readonly<Record<DomainToolName, DomainDefinition>> = catalog
export { domainToolNames }
export const domainWriteTools = domainToolNames.filter((name) => catalog[name].write)
export const domainProfiles = Object.fromEntries(
  [...new Set(domainToolNames.map((name) => catalog[name].domain))]
    .filter((domain) => domain !== 'context')
    .map((domain) => [
      domain,
      [
        'teamgrid_workspace_get',
        ...domainToolNames.filter((name) => catalog[name].domain === domain),
      ],
    ]),
) as Record<string, readonly DomainToolName[]>

const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: true })
addFormats(ajv)
const schemas = new Map<DomainToolName, StandardSchemaWithJSON<Record<string, unknown>>>()

function boundedJson(value: unknown, depth = 0, remaining = { count: 20000 }): boolean {
  if (depth > 32 || --remaining.count < 0) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => boundedJson(item, depth + 1, remaining))
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(
      ([key, item]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        boundedJson(item, depth + 1, remaining),
    )
  )
}

export function domainInputSchema(
  name: DomainToolName,
): StandardSchemaWithJSON<Record<string, unknown>> {
  const cached = schemas.get(name)
  if (cached) return cached
  const schema = catalog[name].inputSchema
  const validate = ajv.compile(schema)
  const result: StandardSchemaWithJSON<Record<string, unknown>> = {
    '~standard': {
      version: 1,
      vendor: 'teamgrid-reviewed-openapi',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value) => {
        if (!boundedJson(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) {
          return { issues: [{ message: 'Input exceeds the bounded JSON contract.' }] }
        }
        if (!validate(value)) {
          // Error messages describe schema failures without echoing customer data.
          return {
            issues: [
              { message: `Invalid operation input: ${validate.errors?.[0]?.keyword || 'schema'}.` },
            ],
          }
        }
        return { value: value as Record<string, unknown> }
      },
    },
  }
  schemas.set(name, result)
  return result
}

export async function executeDomainTool(
  client: TeamGridClient,
  name: DomainToolName,
  input: Record<string, unknown>,
) {
  const operation = catalog[name]
  if (operation.write) {
    const workspace = await client.workspace.get()
    if (workspace.data.id !== input.workspaceId) {
      throw new TeamGridClientError(
        'workspace_mismatch',
        'The credential belongs to another workspace. No change was sent.',
      )
    }
  }
  const response = await domainDispatch[name](client, input)
  // SDK 204 methods return transport metadata, never expose those headers in MCP.
  if (response && typeof response === 'object' && 'data' in response && 'meta' in response) {
    const transport =
      'transport' in response
        ? (response.transport as { headers?: Record<string, string> })
        : undefined
    const etag = transport?.headers?.etag
    // Expose only the precondition needed for a later reviewed write. Other
    // HTTP headers (including credentials and cookies) stay inside the SDK.
    const redactResource = (item: unknown): unknown => {
      if (
        !item ||
        typeof item !== 'object' ||
        !('type' in item) ||
        item.type !== 'webhook' ||
        !('attributes' in item)
      )
        return item
      const { signingSecret: _secret, ...attributes } = item.attributes as Record<string, unknown>
      return { ...item, attributes }
    }
    return {
      data: Array.isArray(response.data)
        ? response.data.map(redactResource)
        : redactResource(response.data),
      meta: {
        ...(response.meta as Record<string, unknown>),
        ...(etag && /^"[\x21\x23-\x7e]{1,256}"$/.test(etag) ? { etag } : {}),
      },
    }
  }
  if (
    !operation.write ||
    !response ||
    typeof response !== 'object' ||
    !('status' in response) ||
    response.status !== 204
  ) {
    throw new TeamGridClientError(
      'invalid_api_response',
      'The API did not return a valid result. Completion could not be confirmed; inspect the target before retrying.',
    )
  }
  return {
    data: {
      type: 'operationResult',
      attributes: { completed: true, operation: operation.operationId },
    },
    meta: {},
  }
}

export function registerDomainTools(
  register: RegisterTeamGridTool,
  client: TeamGridClient,
  result: (value: unknown) => {
    content: { type: 'text'; text: string }[]
    structuredContent: Record<string, unknown>
    isError?: boolean
  },
) {
  for (const name of domainToolNames) {
    register(
      name,
      {
        annotations: catalog[name].annotations,
        description: catalog[name].description,
        inputSchema: domainInputSchema(name),
      },
      async (input) => result(await executeDomainTool(client, name, input)),
    )
  }
}

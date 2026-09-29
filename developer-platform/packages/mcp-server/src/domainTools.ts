import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { type TeamGridClient, TeamGridClientError } from '@teamgrid/api-client'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { fullFormats } from 'ajv-formats/dist/formats.js'
import { projectDocumentContent } from './documentContent.js'
import { maximumMcpResourceBytes, privateResourceUri } from './fileResources.js'
import generatedCatalog from './generated/domainCatalog.json' with { type: 'json' }
import { type DomainToolName, domainDispatch, domainToolNames } from './generated/domainDispatch.js'
import generatedOutputDefinitions from './generated/outputDefinitions.json' with { type: 'json' }
import { operationOutcome } from './outcomes.js'
import type { RegisterTeamGridTool } from './registration.js'
import { boundedSearchMetadata } from './searchCompleteness.js'

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
  outputSchema: Record<string, unknown>
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
        'teamgrid_users_list',
        'teamgrid_tasks_list',
        'teamgrid_task_get',
        'teamgrid_projects_list',
        'teamgrid_project_get',
        'teamgrid_search',
        ...domainToolNames.filter((name) => catalog[name].domain === domain),
      ].filter((name, index, names) => names.indexOf(name) === index),
    ]),
) as Record<string, readonly DomainToolName[]>

const ajv = new Ajv2020({
  strictSchema: true,
  strictTypes: false,
  strictRequired: false,
  allErrors: false,
  ownProperties: true,
  validateFormats: true,
  formats: fullFormats,
})
const schemas = new Map<DomainToolName, StandardSchemaWithJSON<Record<string, unknown>>>()

function semanticInputValid(name: DomainToolName, input: Record<string, unknown>) {
  if (name === 'teamgrid_task_create' || name === 'teamgrid_task_update') {
    const data = input.data as Record<string, unknown>
    const assignees = data.assigneeIds as string[] | null | undefined
    if (data.groupId && (assignees?.length || data.primaryAssigneeId)) return false
    if (
      data.primaryAssigneeId &&
      (name === 'teamgrid_task_create' || assignees !== undefined) &&
      !assignees?.includes(String(data.primaryAssigneeId))
    )
      return false
  }
  if (name === 'teamgrid_appointments_list' || name === 'teamgrid_availability_list') {
    const span = Date.parse(String(input.end)) - Date.parse(String(input.start))
    if (!(span > 0 && span <= 31 * 86400000)) return false
  }
  return true
}

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
        const maximumBytes =
          catalog[name].sdk.startsWith('documents.') && catalog[name].write
            ? 8 * 1024 * 1024
            : 256 * 1024
        if (
          !boundedJson(value) ||
          Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes
        ) {
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
        if (!semanticInputValid(name, value as Record<string, unknown>)) {
          return {
            issues: [{ message: 'Inconsistent assignment or time window (maximum 31 days).' }],
          }
        }
        return { value: value as Record<string, unknown> }
      },
    },
  }
  schemas.set(name, result)
  return result
}

const outputSchemas = new Map<string, StandardSchemaWithJSON<Record<string, unknown>>>()
export function domainOutputSchema(
  name: DomainToolName,
  legacyReadProjection = false,
): StandardSchemaWithJSON<Record<string, unknown>> {
  const cacheKey = `${name}:${legacyReadProjection}`
  const cached = outputSchemas.get(cacheKey)
  if (cached) return cached
  const definitions: Record<string, unknown> = {}
  const shared = generatedOutputDefinitions as Record<string, unknown>
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return
    if ('$ref' in value && typeof value.$ref === 'string') {
      const key = value.$ref.replace('#/$defs/', '')
      if (!(key in shared)) throw new Error('Unknown output definition.')
      if (!(key in definitions)) {
        definitions[key] = shared[key]
        collect(shared[key])
      }
    }
    for (const child of Object.values(value)) collect(child)
  }
  collect(catalog[name].outputSchema)
  if (legacyReadProjection) {
    for (const [name, fields] of Object.entries({
      Product: ['purchasePrice'],
      TimeEntry: ['billable', 'billed', 'billedAt'],
    })) {
      if (!definitions[name]) continue
      const definition = structuredClone(definitions[name]) as {
        properties: { attributes: { properties: Record<string, unknown>; required?: string[] } }
      }
      const attrs = definition.properties.attributes
      for (const field of fields) delete attrs.properties[field]
      if (attrs.required) attrs.required = attrs.required.filter((field) => !fields.includes(field))
      definitions[name] = definition
    }
  }
  const schema = { ...catalog[name].outputSchema, $defs: definitions }
  const validate = ajv.compile(schema)
  const result: StandardSchemaWithJSON<Record<string, unknown>> = {
    '~standard': {
      version: 1,
      vendor: 'teamgrid-reviewed-openapi',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value) =>
        validate(value)
          ? { value: value as Record<string, unknown> }
          : {
              issues: [{ message: 'The API result does not match the operation output contract.' }],
            },
    },
  }
  outputSchemas.set(cacheKey, result)
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
    const projected =
      operation.sdk.startsWith('documents.') && !Array.isArray(response.data)
        ? projectDocumentContent(response.data, input, etag, operation.write)
        : { data: response.data, meta: {} }
    return {
      data: Array.isArray(projected.data)
        ? projected.data.map(redactResource)
        : redactResource(projected.data),
      meta: {
        ...(response.meta as Record<string, unknown>),
        ...projected.meta,
        ...operationOutcome(response.data, operation.write),
        ...((operation.sdk === 'files.get' || operation.sdk === 'exports.get') &&
        response.data &&
        typeof response.data === 'object' &&
        'id' in response.data &&
        typeof response.data.id === 'string'
          ? {
              privateResource: {
                uri: privateResourceUri(
                  operation.sdk === 'files.get' ? 'files' : 'exports',
                  response.data.id,
                ),
                maxBytes: maximumMcpResourceBytes,
                readMethod: 'resources/read',
              },
            }
          : {}),
        ...(operation.sdk === 'search.query'
          ? {
              search: boundedSearchMetadata(
                response.data,
                (input.data as Record<string, unknown> | undefined)?.limit,
              ),
            }
          : {}),
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
    meta: { outcome: 'completed' },
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

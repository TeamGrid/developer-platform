import { readFileSync } from 'node:fs'

type Schema = { example?: unknown }
type ApiOperation = {
  operationId: string
  responses: Record<
    string,
    {
      content?: { 'application/json'?: Schema }
    }
  >
}
const api = JSON.parse(
  readFileSync(new URL('../../../../openapi/v1.json', import.meta.url), 'utf8'),
) as {
  paths: Record<string, Record<string, ApiOperation>>
}
/** Independent API examples replace incomplete synthetic responses in transport tests. */
export function responseFixture(operationId: string, id?: string) {
  const operation = Object.values(api.paths)
    .flatMap((path) => Object.values(path))
    .find((operation) => operation.operationId === operationId)
  const response = Object.entries(operation?.responses ?? {}).find(([status]) =>
    /^20[012]$/.test(status),
  )?.[1]
  const result = structuredClone(response?.content?.['application/json']?.example) as {
    data: { id: string; type: string; attributes: Record<string, unknown> }
    meta: { requestId: string }
  }
  if (!result?.data) throw new Error(`Missing canonical test example for ${operationId}`)
  // Tests select a known user context and omit reveal-once webhook secrets,
  // matching the MCP projection. Other values come from schema-checked API examples.
  if (result.data.type === 'workspace')
    result.data.attributes.context = {
      identityKind: 'personal',
      subjectUserId: 'user1',
      timeZone: 'Europe/Berlin',
      timeZoneSource: 'user-profile',
    }
  if (result.data.type === 'webhook') delete result.data.attributes.signingSecret
  if (id) result.data.id = id
  return result
}

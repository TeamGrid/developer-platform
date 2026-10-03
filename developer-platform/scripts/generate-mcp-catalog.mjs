import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { compactMcpInputSchema } from './mcp-input-schema.mjs'
import { mcpOutputSchema } from './mcp-output-schema.mjs'

const root = new URL('../', import.meta.url)
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const api = await read('../openapi/v1.json')
const policy = (await read('../openapi/developer-capabilities.json')).operationPolicy
const clientPath = fileURLToPath(new URL('packages/api-client/src/client.ts', root))
const program = ts.createProgram([clientPath], {
  strict: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true,
})
const checker = program.getTypeChecker()
const declaration = program.getSourceFile(clientPath).statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === 'TeamGridClient',
)
const clientType = checker.getTypeAtLocation(declaration)
let cyclicRefs = new Set()
function resolve(value, stack = []) {
  if (Array.isArray(value)) return value.map((item) => resolve(item, stack))
  if (!value || typeof value !== 'object') return value
  if (value.$ref) {
    if (!value.$ref.startsWith('#/')) throw Error('Nonlocal MCP schema')
    if (stack.includes(value.$ref)) {
      cyclicRefs.add(value.$ref)
      return { $ref: `#/$defs/${value.$ref.split('/').at(-1)}` }
    }
    const target = value.$ref.slice(2).split('/').reduce((item, key) => item[key], api)
    const { $ref, ...rest } = value
    return resolve({ ...target, ...rest }, [...stack, $ref])
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['example', 'examples', 'deprecated'].includes(key))
    .map(([key, item]) => [key, resolve(item, stack)]))
}
const catalog = {}
const sharedOutputDefinitions = {}
const dispatch = []
for (const entry of policy.filter((entry) => entry.mcp.exposure !== 'forbidden')) {
  cyclicRefs = new Set()
  const operation = api.paths[entry.path][entry.method.toLowerCase()]
  const parameters = resolve(operation.parameters || [])
  const write = entry.mcp.exposure === 'gated-write'
  let methodType = clientType
  for (const key of entry.sdk.split('.')) {
    const symbol = methodType.getProperty(key)
    if (!symbol) throw Error(`Missing SDK method ${entry.sdk}`)
    methodType = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  }
  const sdkArguments = methodType.getCallSignatures()[0].getParameters().map((parameter) => parameter.name)
  const shape = { type: 'object', additionalProperties: false, properties: {}, required: [] }
  const put = (name, schema, required) => {
    shape.properties[name] = schema
    if (required) shape.required.push(name)
  }
  if (write) put('workspaceId', { type: 'string', minLength: 1, maxLength: 128,
    description: 'Workspace returned by teamgrid_workspace_get and selected for this exact action.' }, true)
  const pathParameters = parameters.filter((parameter) => parameter.in === 'path')
  const nonBodyArguments = sdkArguments.filter((name) => !['data', 'options', 'fieldIds'].includes(name))
  if (pathParameters.length !== nonBodyArguments.length) throw Error(`Review SDK path mapping: ${entry.operationId}`)
  pathParameters.forEach((parameter, index) => put(nonBodyArguments[index], parameter.schema, parameter.required))
  const query = parameters.filter((parameter) => parameter.in === 'query')
  for (const parameter of query) put(parameter.name, parameter.schema, parameter.required)
  const ifMatch = parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'If-Match')
  const ifNoneMatch = parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'If-None-Match')
  if (ifMatch) put('expectedRevision', { ...ifMatch.schema,
    description: 'Exact strong ETag (including quotes) from the read reviewed for this action. Never replace it automatically after a conflict.' }, ifMatch.required)
  if (ifNoneMatch) {
    put('createIfMissing', { type: 'boolean', const: true,
      description: 'Create only an absent future occurrence. Mutually exclusive with expectedRevision.' }, false)
    shape.oneOf = [{ required: ['expectedRevision'], not: { required: ['createIfMissing'] } },
      { required: ['createIfMissing'], not: { required: ['expectedRevision'] } }]
  }
  const idempotent = parameters.some((parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key')
  if (idempotent) put('idempotencyKey', { type: 'string', minLength: 1, maxLength: 128,
    pattern: '^[\\x21-\\x7e]+$', description: 'Stable key for this exact intent. Retain and reuse the same key and payload after a timeout; a timeout does not prove failure.' }, true)
  const body = operation.requestBody?.content?.['application/json']?.schema
  if (body) put('data', resolve(body), operation.requestBody.required)
  if (entry.operationId === 'getDocument') {
    // Local bounded projection only; never forwarded as new API query parameters.
    put('contentOffset', { type: 'integer', minimum: 0, maximum: 1048576, description: 'UTF-16 offset from meta.contentPage.nextOffset. Continuations require expectedRevision.' }, false)
    put('contentLimit', { type: 'integer', minimum: 1, maximum: 16384, default: 16384 }, false)
    put('expectedRevision', { type: 'string', minLength: 3, maxLength: 258, pattern: '^"[\\x21\\x23-\\x7e]+"$', description: 'Exact meta.etag from the first chunk; prevents mixing document versions.' }, false)
  }
  if (cyclicRefs.size) {
    shape.$defs = {}
    for (const ref of cyclicRefs) shape.$defs[ref.split('/').at(-1)] = resolve(
      ref.slice(2).split('/').reduce((item, key) => item[key], api), [ref],
    )
  }
  if (sdkArguments.includes('fieldIds') && !body) throw Error('Missing custom field batch body')
  // Transport-only inputs are never accepted. Exposed fields come only from the
  // finite reviewed operation, not SDK RequestOptions, headers, tokens or URLs.
  const options = [
    ...query.map((parameter) => `${JSON.stringify(parameter.name)}: input[${JSON.stringify(parameter.name)}]`),
    ...(ifMatch ? ['ifMatch: input.expectedRevision'] : []),
    ...(ifNoneMatch ? ["...(input.createIfMissing === true ? { createIfMissing: true } : {})"] : []),
    ...(idempotent ? ['idempotencyKey: input.idempotencyKey'] : []),
  ]
  const sdkType = `TeamGridClient${entry.sdk.split('.').map((key) => `[${JSON.stringify(key)}]`).join('')}`
  const args = sdkArguments.map((name, index) => {
    let expression = name === 'options' ? `{ ${options.join(', ')} }`
      : name === 'fieldIds' ? '(input.data as { fieldIds: string[] }).fieldIds'
        : `input.${name}`
    if (name === 'data' && !operation.requestBody?.required) expression = '(input.data ?? {})'
    return `${expression} as Parameters<${sdkType}>[${index}]`
  })
  dispatch.push(`  ${JSON.stringify(entry.mcp.tool)}: (client, ${args.join().includes('input.') || args.join().includes('input[') ? 'input' : '_input'}) => client.${entry.sdk}(${args.join(', ')}),`)
  const perItemRevision = entry.operationId === 'bulkUpdateTasks'
  const concurrency = perItemRevision ? 'per-item revision' : ifMatch ? 'conditional' : write ? 'unconditional' : 'read'
  let description = operation.summary || entry.operationId
  if (entry.operationId === 'getDocument') description += '. Content is a bounded chunk, not necessarily the whole document. Continue with contentOffset=meta.contentPage.nextOffset and expectedRevision=meta.etag until nextOffset is null. Never infer omitted content or overwrite a document from an incomplete read.'
  if (write && entry.sdk.startsWith('documents.')) description += '. Returns a compact mutation receipt without repeating document content. Read content through teamgrid_document_get.'
  if (write) description += '. Changes the selected workspace under current API permissions.'
  if (ifMatch) description += ' Read the target first; submit its exact ETag. On conflict, review the current state before making a new decision.'
  if (perItemRevision) description += ' Each item requires the developerRevision from its reviewed task. Results are independent: inspect every item for success, conflict or failure. Never refresh revisions and retry the entire batch automatically.'
  if (write && !ifMatch && !idempotent && !perItemRevision) description += ' The API has no conditional-write or replay contract for this action. Do not retry an uncertain result automatically; read the current state first.'
  if (idempotent) description += ' Reuse the same idempotencyKey and payload for the same intent.'
  if (write && (entry.sdk.startsWith('invitations.') || entry.sdk.startsWith('comments.'))) description += ' May notify other people.'
  if (write && (entry.sdk.startsWith('automation') || entry.sdk.startsWith('taskRecurrence'))) description += ' Changes can affect future automated actions; inspect the definition and schedule first.'
  if (write && (entry.mcp.domain === 'admin-write' || entry.operationId === 'replaceProjectSharing')) description += ' Administrative action: review the exact target and access impact with the user.'
  if (operation.responses?.['202']) description += ' Acceptance is not completion. Use the corresponding operation-get tool to inspect the returned operation until terminal.'
  const { $defs: outputDefinitions, ...outputSchema } = mcpOutputSchema(api, operation)
  for (const [name, schema] of Object.entries(outputDefinitions || {})) {
    if (sharedOutputDefinitions[name] && JSON.stringify(sharedOutputDefinitions[name]) !== JSON.stringify(schema))
      throw Error(`Conflicting output definition ${name}`)
    sharedOutputDefinitions[name] = schema
  }
  catalog[entry.mcp.tool] = {
    operationId: entry.operationId, sdk: entry.sdk, method: entry.method, path: entry.path,
    domain: entry.mcp.domain, write, concurrency, idempotency: idempotent,
    coreCas: operation['x-teamgrid-resource-cas'] === 'resource-cas-v1' || entry.operationId === 'bulkUpdateTasks',
    description, inputSchema: compactMcpInputSchema(shape), outputSchema,
    annotations: { readOnlyHint: !write, destructiveHint: write && !/^create/.test(entry.operationId),
      idempotentHint: !write || idempotent || Boolean(ifMatch),
      // Bounded workspace reads never contact the configured recipients or targets.
      // These domains can reach external entities when a mutation changes or sends work.
      openWorldHint: write && (entry.sdk.startsWith('webhooks.') || entry.sdk.startsWith('automation') || entry.sdk.startsWith('invitations.')) },
  }
}
const source = `// Generated by scripts/generate-mcp-catalog.mjs from the reviewed canonical contract.\nimport type { TeamGridClient } from '@teamgrid/api-client'\n\nexport const domainToolNames = ${JSON.stringify(Object.keys(catalog).sort())} as const\nexport type DomainToolName = (typeof domainToolNames)[number]\n\nexport const domainDispatch: Record<DomainToolName, (client: TeamGridClient, input: Record<string, unknown>) => Promise<unknown>> = {\n${dispatch.join('\n')}\n}\n`
const rows = Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))
const excluded = policy.filter((entry) => entry.mcp.exposure === 'forbidden')
const coverage = [
  '# Candidate MCP coverage', '',
  'Generated from the reviewed canonical API contract. Not a publication or live qualification claim.', '',
  `The full profile contains ${rows.length} tools: ${rows.filter(([, entry]) => !entry.write).length} reads and ${rows.filter(([, entry]) => entry.write).length} writes. ${excluded.length} API operations use other connection or transfer surfaces.`, '',
  'All writes require workspaceId and current API authorization. Conditional tools accept the exact quoted meta.etag returned by the preceding read. Per-item revision uses data.items[].revision. Unconditional means the API has no revision precondition. Idempotency keys protect repetition of one intent, not concurrent edits.', '',
  'Domain profiles include their listed tools plus workspace, user, task/project lookup and search tools. Scope reports list base/compound scopes; optional finance, sharing and cross-resource fields can require additional server-side scopes. A listed tool does not grant roles, scopes or product entitlements.', '',
  '| Tool | Domain profile | Mode | Concurrency | Stable key required |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(([name, entry]) => `| \`${name}\` | ${entry.domain} | ${entry.write ? 'write' : 'read'} | ${entry.concurrency} | ${entry.idempotency ? 'yes' : '—'} |`),
  '', '## Operations deliberately outside MCP', '',
  '| API operation | Reason |', '| --- | --- |',
  ...excluded.map((entry) => `| \`${entry.operationId}\` | ${entry.mcp.reason} |`), '',
].join('\n')
for (const [path, content] of [
  ['packages/mcp-server/src/generated/outputDefinitions.json', `${JSON.stringify(sharedOutputDefinitions, null, 2)}\n`],
  ['packages/mcp-server/src/generated/domainCatalog.json', `${JSON.stringify(catalog, null, 2)}\n`],
  ['packages/mcp-server/src/generated/domainDispatch.ts', source],
  ['packages/mcp-server/COVERAGE.md', coverage],
]) {
  const target = new URL(path, root)
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== content) throw Error(`Stale MCP catalog: ${path}`)
  } else await writeFile(target, content)
}
console.log(`Generated ${Object.keys(catalog).length} reviewed MCP operations.`)

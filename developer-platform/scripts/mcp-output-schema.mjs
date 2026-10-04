// Preserve local definitions instead of repeatedly expanding nested resource graphs.
export function mcpOutputSchema(api, operation) {
  const definitions = {}
  const text = { type: 'string' }
  const integer = { type: 'integer', minimum: 0 }
  const extension = {
    privateResource: { type: 'object', additionalProperties: false,
      required: ['uri', 'maxBytes', 'readMethod'], properties: {
        uri: { type: 'string', pattern: '^teamgrid://(?:files|exports)/[A-Za-z0-9_.:%-]+$' },
        maxBytes: { const: 1048576 }, readMethod: { const: 'resources/read' },
      } },
    etag: { type: 'string', pattern: '^"[\\x21\\x23-\\x7e]{1,256}"$' },
    resume: { type: 'object', additionalProperties: false, required: ['tool', 'arguments'], properties: {
      tool: { enum: ['teamgrid_project_lifecycle_operation_get', 'teamgrid_planned_work_operation_get', 'teamgrid_task_recurrence_operation_get', 'teamgrid_export_get'] },
      arguments: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 } } },
    } },
    outcome: { enum: ['completed', 'accepted', 'partial', 'unknown', 'failed'] },
    omittedFields: { type: 'array', items: text },
    contentReadTool: { const: 'teamgrid_document_get' },
    contentPage: { type: 'object', additionalProperties: false,
      properties: { unit: { const: 'utf16' }, offset: integer,
        nextOffset: { type: ['integer', 'null'], minimum: 0 }, totalLength: integer,
        complete: { type: 'boolean' }, revision: { type: ['string', 'null'] } },
      required: ['unit', 'offset', 'nextOffset', 'totalLength', 'complete', 'revision'] },
    search: { type: 'object', additionalProperties: false,
      properties: { complete: { const: false }, indexed: { const: true }, returned: integer,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        continuation: { const: 'narrow-query-or-list' }, verification: { const: 'read-by-id' } },
      required: ['complete', 'indexed', 'returned', 'limit', 'continuation', 'verification'] },
  }
  if (operation.operationId === 'getContact') extension.notesPage = extension.contentPage
  if (operation.operationId === 'listContacts')
    extension.notesReadTool = { const: 'teamgrid_contact_get' }
  const dereference = (ref) => {
    if (!ref.startsWith('#/components/schemas/')) throw new Error(`Unsupported output reference ${ref}`)
    const name = ref.split('/').at(-1)
    if (!api.components.schemas[name]) throw new Error(`Missing output definition ${name}`)
    return [name, api.components.schemas[name]]
  }
  function visit(value, key) {
    if (Array.isArray(value)) return value.map(item => visit(item))
    if (!value || typeof value !== 'object') return value
    if (key === 'meta') {
      const schema = value.$ref ? dereference(value.$ref)[1] : value
      return visit({ ...schema, properties: { ...schema.properties, ...extension } })
    }
    if (value.$ref) {
      const [name, target] = dereference(value.$ref)
      if (!(name in definitions)) {
        definitions[name] = null
        definitions[name] = visit(target)
        // MCP never returns webhook signing secrets, including creation responses.
        if (name === 'Webhook') {
          const attrs = definitions[name].properties.attributes
          delete attrs.properties.signingSecret
          attrs.required = attrs.required?.filter(name => name !== 'signingSecret')
        }
        if (name === 'Document')
          definitions[name].properties.attributes.properties.content.maxLength = 16384
      }
      const { $ref, ...rest } = value
      return { ...visit(rest), $ref: `#/$defs/${name}` }
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['example', 'examples', 'deprecated'].includes(key))
      .map(([key, item]) => [key, visit(item, key)]))
  }
  const variants = Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status))
    .map(([status, response]) => {
      if (status === '204') return {
        type: 'object', additionalProperties: false, required: ['data', 'meta'],
        properties: {
          data: { type: 'object', additionalProperties: false, required: ['type', 'attributes'],
            properties: { type: { const: 'operationResult' }, attributes: {
              type: 'object', additionalProperties: false, required: ['completed', 'operation'],
              properties: { completed: { const: true }, operation: { const: operation.operationId } },
            } } },
          meta: { type: 'object', properties: extension, additionalProperties: false },
        },
      }
      const schema = response.content?.['application/json']?.schema
      if (!schema) throw new Error(`Missing JSON output for ${operation.operationId}`)
      return visit(schema)
    })
  if (!variants.length) throw new Error(`Missing successful output for ${operation.operationId}`)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(operation['x-teamgrid-mcp-method'] || 'GET')) {
    const receipt = { type: 'object', additionalProperties: false, required: ['type', 'attributes'], properties: {
      type: { const: 'mutationReceipt' }, attributes: { type: 'object', additionalProperties: false,
        required: ['operation', 'resources'], properties: {
          operation: { type: 'string', maxLength: 128 },
          resources: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false,
            required: ['type'], properties: { id: {type:'string',maxLength:128},
              type: {type:'string',maxLength:128}, status: {type:'string',maxLength:64} } } },
        } },
    } }
    definitions.McpMutationReceipt = receipt
    for (let index = 0; index < variants.length; index++) {
      const original = variants[index]
      const variant = original.$ref
        ? structuredClone(definitions[original.$ref.replace('#/$defs/', '')]) : original
      variants[index] = variant
      variant.properties.data = { anyOf: [variant.properties.data, { allOf: [
        { $ref: '#/$defs/McpMutationReceipt' },
        { properties: { attributes: { properties: { operation: { const: operation.operationId } } } } },
      ] }] }
    }
  }
  return { ...(variants.length === 1 ? variants[0] : { type: 'object', anyOf: variants }),
    ...(Object.keys(definitions).length ? { $defs: definitions } : {}) }
}

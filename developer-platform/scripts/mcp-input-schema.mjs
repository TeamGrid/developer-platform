const singleSchemaKeys = new Set([
  'additionalProperties', 'items', 'contains', 'not', 'if', 'then', 'else',
  'propertyNames', 'contentSchema', 'unevaluatedProperties', 'unevaluatedItems',
])
const arraySchemaKeys = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const namedSchemaKeys = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
])

// Visit schema positions only: objects inside enum/default/examples are values.
function mapChildren(schema, visit) {
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (singleSchemaKeys.has(key)) return [key, visit(value)]
    if (arraySchemaKeys.has(key) && Array.isArray(value)) return [key, value.map(visit)]
    if (namedSchemaKeys.has(key) && value && typeof value === 'object')
      return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]))]
    return [key, value]
  }))
}

/** Factor repeated large schemas into local references without changing constraints. */
export function compactMcpInputSchema(schema) {
  const source = JSON.stringify(schema)
  if (Buffer.byteLength(source) < 32 * 1024) return schema
  const repeated = new Map()
  let portable = true
  function collect(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    // Moving anchors, dialects or pointers into inline properties can change
    // resolution. The reviewed inputs use only whole root-level $defs references.
    if (['$id', '$schema', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveRef', '$recursiveAnchor']
      .some(key => Object.hasOwn(value, key)) ||
      (value.$ref !== undefined && !/^#\/\$defs\/[^/]+$/.test(value.$ref))) portable = false
    const key = JSON.stringify(value)
    if (Buffer.byteLength(key) >= 512) {
      const entry = repeated.get(key)
      repeated.set(key, { value, count: (entry?.count ?? 0) + 1 })
    }
    return mapChildren(value, collect)
  }
  collect(schema)
  if (!portable) return schema
  const definitions = { ...schema.$defs }
  const references = new Map()
  let index = 0
  for (const [key, entry] of repeated) {
    if (entry.count < 2) continue
    let name
    do { name = `tgInputSchema${++index}` } while (Object.hasOwn(definitions, name))
    definitions[name] = entry.value
    references.set(key, name)
  }
  function replace(value, skip) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const key = JSON.stringify(value)
    const name = references.get(key)
    if (name && key !== skip) return { $ref: `#/$defs/${name}` }
    return mapChildren(value, child => replace(child))
  }
  const result = replace(schema, source)
  for (const [key, name] of references)
    definitions[name] = replace(repeated.get(key).value, key)
  result.$defs = { ...result.$defs, ...definitions }
  return Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(source) ? result : schema
}

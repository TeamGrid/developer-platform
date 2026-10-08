import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const contract = 'teamgrid-mcp-positive-fixture-v1'
const template = /\$\{([A-Za-z][A-Za-z0-9_.-]{0,127})\}/g
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digest = /^[a-f0-9]{64}$/
const own = (value, key) => Object.hasOwn(value, key)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const workspaceTemplate = `\${workspaceId}`

function exact(value, keys) {
  assert(
    record(value) && Object.keys(value).sort().join() === [...keys].sort().join(),
    'Positive MCP fixture fields differ',
  )
}

function identity(value, now) {
  assert(
    record(value) && /^teamgrid-native-oauth-[a-f0-9]{24}$/.test(value.project || ''),
    'Only an owned disposable native fixture is allowed',
  )
  assert(
    value.origin === `https://${value.project}-mcp.teamgrid.app` &&
      value.databaseName === `fixture_${value.project.slice(-24)}` &&
      value.cellId === value.project &&
      value.customerData === false,
    'Positive MCP fixture isolation differs',
  )
  assert(
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value.workspaceId || '') &&
      /^[a-f0-9]{40}$/.test(value.sdkSourceRevision || '') &&
      digest.test(value.sourceCatalogSha256 || '') &&
      digest.test(value.recipeManifestSha256 || '') &&
      digest.test(value.manifestSha256 || ''),
    'Positive MCP fixture source binding differs',
  )
  const created = Date.parse(value.createdAt)
  const deadline = Date.parse(value.deadline)
  assert(
    created <= now && now < deadline && deadline - created <= 1800000 && deadline > created,
    'Positive MCP fixture expired',
  )
  return value
}

function resolve(value, variables) {
  if (typeof value === 'string') {
    // A whole-value placeholder preserves captured arrays, numbers and objects.
    const whole = /^\$\{([A-Za-z][A-Za-z0-9_.-]{0,127})\}$/.exec(value)
    if (whole) {
      assert(own(variables, whole[1]), 'Positive MCP fixture variable is unavailable')
      return structuredClone(variables[whole[1]])
    }
    const result = value.replaceAll(template, (_match, name) => {
      assert(
        own(variables, name) && ['string', 'number', 'boolean'].includes(typeof variables[name]),
        'Positive MCP fixture text variable is unavailable',
      )
      return String(variables[name])
    })
    assert(!result.includes('${'), 'Positive MCP fixture template differs')
    return result
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, variables))
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolve(item, variables)]),
    )
  return value
}

function capture(value, pointer) {
  assert(
    typeof pointer === 'string' && /^\/(?:[^~]|~[01])*$/.test(pointer) && pointer.length <= 1024,
    'Positive MCP capture pointer differs',
  )
  return pointer
    .slice(1)
    .split('/')
    .reduce((item, encoded) => {
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
      assert(
        item !== null && typeof item === 'object' && own(item, key),
        'Positive MCP capture is absent',
      )
      return item[key]
    }, value)
}

function readCatalog(bytes, fixture) {
  assert(
    (typeof bytes === 'string' || Buffer.isBuffer(bytes)) &&
      Buffer.byteLength(bytes) <= 16 * 1024 * 1024 &&
      createHash('sha256').update(bytes).digest('hex') === fixture.sourceCatalogSha256,
    'Positive MCP catalog bytes differ',
  )
  const catalog = JSON.parse(bytes.toString())
  assert(record(catalog), 'Positive MCP catalog is invalid')
  return catalog
}

async function bounded(action, milliseconds) {
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort()
            reject(new Error('Positive MCP fixture deadline exceeded'))
          },
          Math.max(1, Math.min(30000, milliseconds)),
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** This checks complete positive coverage, never substitutes for the protected
 * native-release producer. The caller must supply genuine private fixture
 * observers and a transport to the unchanged image, not a production endpoint. */
export function validateMcpPositiveRecipes({
  manifest,
  catalogBytes,
  fixture,
  initialVariables = {},
  now = Date.now(),
}) {
  identity(fixture, now)
  const catalog = readCatalog(catalogBytes, fixture)
  exact(manifest, ['contract', 'project', 'sdkSourceRevision', 'sourceCatalogSha256', 'recipes'])
  assert(hash(manifest) === fixture.recipeManifestSha256, 'Positive MCP recipe bytes differ')
  assert(
    manifest.contract === contract &&
      manifest.project === fixture.project &&
      manifest.sdkSourceRevision === fixture.sdkSourceRevision &&
      manifest.sourceCatalogSha256 === fixture.sourceCatalogSha256,
    'Positive MCP recipe source differs',
  )
  const names = Object.keys(catalog).sort()
  assert(
    names.length > 0 && names.every((name) => /^teamgrid_[a-z][a-z0-9_]+$/.test(name)),
    'Positive MCP catalog is invalid',
  )
  assert(
    Array.isArray(manifest.recipes) &&
      manifest.recipes.length === names.length &&
      JSON.stringify(manifest.recipes.map((recipe) => recipe?.tool).sort()) ===
        JSON.stringify(names),
    'Every published MCP tool needs exactly one positive recipe',
  )
  assert(
    record(initialVariables) &&
      !own(initialVariables, 'workspaceId') &&
      !own(initialVariables, 'fixtureNamespace'),
    'Reserved fixture variables cannot be replaced',
  )
  const variables = new Set(['workspaceId', 'fixtureNamespace', ...Object.keys(initialVariables)])
  for (const recipe of manifest.recipes) {
    exact(recipe, ['tool', 'arguments', 'captures', 'expect'])
    assert(
      record(recipe.arguments) &&
        Buffer.byteLength(JSON.stringify(recipe.arguments)) <= 8 * 1024 * 1024,
      'Positive MCP arguments are invalid',
    )
    const unresolved = JSON.stringify([recipe.arguments, recipe.expect]).replaceAll(
      template,
      (_match, name) => {
        assert(variables.has(name), 'Positive MCP recipe has an unresolved dependency')
        return ''
      },
    )
    assert(!unresolved.includes('${'), 'Positive MCP fixture template differs')
    assert(
      record(recipe.expect) &&
        Object.keys(recipe.expect).length > 0 &&
        Object.keys(recipe.expect).every((pointer) => pointer.startsWith('/')),
      'Positive MCP recipes require explicit response expectations',
    )
    assert(record(recipe.captures), 'Positive MCP captures are invalid')
    for (const [name, pointer] of Object.entries(recipe.captures)) {
      assert(
        /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) &&
          !variables.has(name) &&
          typeof pointer === 'string' &&
          pointer.startsWith('/'),
        'Positive MCP capture cannot replace another variable',
      )
      variables.add(name)
    }
    const definition = catalog[recipe.tool]
    assert(
      typeof definition.operationId === 'string' && typeof definition.write === 'boolean',
      'Positive MCP operation binding is missing',
    )
    if (definition.write)
      assert(
        recipe.arguments.workspaceId === workspaceTemplate ||
          recipe.arguments.workspaceId === fixture.workspaceId,
        'Positive MCP write targets another workspace',
      )
  }
  return manifest.recipes
}

export async function executeMcpPositiveFixture({
  manifest,
  catalogBytes,
  fixture,
  initialVariables = {},
  callTool,
  inspectFixture,
  validateInput,
  validateOutput,
  observeEffect,
  writeIntent,
  cleanup,
  now = Date.now,
}) {
  const recipes = validateMcpPositiveRecipes({
    manifest,
    catalogBytes,
    fixture,
    initialVariables,
    now: now(),
  })
  const catalog = readCatalog(catalogBytes, fixture)
  for (const dependency of [
    callTool,
    inspectFixture,
    validateInput,
    validateOutput,
    observeEffect,
    writeIntent,
    cleanup,
  ]) {
    assert(typeof dependency === 'function', 'Positive MCP fixture adapter is missing')
  }
  const variables = {
    ...structuredClone(initialVariables),
    workspaceId: fixture.workspaceId,
    fixtureNamespace: fixture.project,
  }
  const results = []
  let failed = false
  let cleanupVerified = false
  const withinFixture = (action) => {
    identity(fixture, now())
    return bounded(action, Date.parse(fixture.deadline) - now())
  }
  try {
    for (const recipe of recipes) {
      if (failed) {
        results.push({ tool: recipe.tool, outcome: 'not_run' })
        continue
      }
      const definition = catalog[recipe.tool]
      try {
        const observed = identity(
          await withinFixture((signal) => inspectFixture({ signal })),
          now(),
        )
        assert.deepEqual(observed, fixture, 'Physical MCP fixture identity changed')
        const args = resolve(recipe.arguments, variables)
        if (definition.write)
          assert(args.workspaceId === fixture.workspaceId, 'MCP workspace changed')
        assert(
          (await withinFixture((signal) => validateInput(recipe.tool, args, { signal }))) === true,
          'MCP arguments violate the pinned input schema',
        )
        const requestSha256 = hash({ name: recipe.tool, arguments: args })
        const binding = {
          project: fixture.project,
          workspaceId: fixture.workspaceId,
          tool: recipe.tool,
          operationId: definition.operationId,
          requestSha256,
        }
        // Persist intent before I/O. No automatic retry after an uncertain receipt.
        let beforeSha256
        if (definition.write) {
          const intent = await withinFixture((signal) => writeIntent(binding, { signal }))
          exact(intent, [...Object.keys(binding), 'beforeSha256'])
          for (const [key, value] of Object.entries(binding)) {
            assert(intent[key] === value, 'MCP mutation intent belongs to another operation')
          }
          assert(digest.test(intent.beforeSha256), 'MCP mutation pre-state is missing')
          beforeSha256 = intent.beforeSha256
        }
        const result = await withinFixture((signal) =>
          callTool({ name: recipe.tool, arguments: args }, { signal }),
        )
        assert(
          record(result) && result.isError !== true && record(result.structuredContent),
          'MCP tool did not return a successful structured result',
        )
        const response = result.structuredContent
        assert(
          (await withinFixture((signal) => validateOutput(recipe.tool, response, { signal }))) ===
            true,
          'MCP result violates the pinned output schema',
        )
        for (const [pointer, expected] of Object.entries(resolve(recipe.expect, variables))) {
          assert.deepEqual(
            capture(response, pointer),
            expected,
            'MCP response differs from the recipe',
          )
        }
        const responseSha256 = hash(response)
        if (definition.write) {
          const effect = await withinFixture((signal) =>
            observeEffect({ ...binding, responseSha256 }, { signal }),
          )
          exact(effect, [
            ...Object.keys(binding),
            'responseSha256',
            'beforeSha256',
            'afterSha256',
            'completed',
            'resourceIdSha256',
          ])
          for (const [key, value] of Object.entries(binding))
            assert(effect[key] === value, 'Observed MCP effect belongs to another operation')
          assert(
            effect.responseSha256 === responseSha256 &&
              effect.completed === true &&
              digest.test(effect.resourceIdSha256) &&
              effect.beforeSha256 === beforeSha256 &&
              digest.test(effect.afterSha256) &&
              effect.beforeSha256 !== effect.afterSha256,
            'A receipt or queued acceptance does not prove the requested effect',
          )
        }
        identity(fixture, now())
        for (const [name, pointer] of Object.entries(recipe.captures)) {
          const value = capture(response, pointer)
          assert(
            Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024,
            'MCP capture is too large',
          )
          variables[name] = structuredClone(value)
        }
        results.push({
          tool: recipe.tool,
          operationId: definition.operationId,
          outcome: 'passed',
          requestSha256,
          responseSha256,
          effectObserved: definition.write,
        })
      } catch {
        // Error text can include private arguments, credentials or customer records.
        failed = true
        results.push({ tool: recipe.tool, operationId: definition.operationId, outcome: 'failed' })
      }
    }
  } finally {
    try {
      const value = await bounded((signal) => cleanup({ signal }), 30000)
      cleanupVerified =
        value?.project === fixture.project &&
        value.customerData === false &&
        value.fixtureRemoved === true &&
        value.grantsRevoked === true &&
        value.runtimeTerminated === true
    } catch {
      cleanupVerified = false
    }
  }
  return {
    contract,
    project: fixture.project,
    sdkSourceRevision: fixture.sdkSourceRevision,
    sourceCatalogSha256: fixture.sourceCatalogSha256,
    recipeManifestSha256: fixture.recipeManifestSha256,
    manifestSha256: fixture.manifestSha256,
    results,
    publishedToolCount: recipes.length,
    positiveToolCount: results.filter((result) => result.outcome === 'passed').length,
    executionComplete: !failed && cleanupVerified,
    cleanupVerified,
    // Only the separate protected producer may issue release qualification.
    runtimeQualificationProduced: false,
    productionDeployment: false,
  }
}

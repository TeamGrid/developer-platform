import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { executeMcpPositiveFixture, validateMcpPositiveRecipes } from './mcp-positive-fixture.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const workspaceTemplate = `\${workspaceId}`
const namespaceTemplate = `\${fixtureNamespace}`
const taskTemplate = `\${taskId}`

function setup() {
  const project = `teamgrid-native-oauth-${'a'.repeat(24)}`
  const catalogBytes = JSON.stringify(
    {
      teamgrid_task_create: { operationId: 'createTask', write: true },
      teamgrid_task_get: { operationId: 'getTask', write: false },
    },
    null,
    2,
  )
  const fixture = {
    project,
    origin: `https://${project}-mcp.teamgrid.app`,
    databaseName: `fixture_${'a'.repeat(24)}`,
    cellId: project,
    customerData: false,
    workspaceId: 'owned-workspace',
    sdkSourceRevision: 'b'.repeat(40),
    sourceCatalogSha256: sha256(catalogBytes),
    manifestSha256: 'c'.repeat(64),
    createdAt: new Date(Date.now() - 1000).toISOString(),
    deadline: new Date(Date.now() + 120000).toISOString(),
  }
  const manifest = {
    contract: 'teamgrid-mcp-positive-fixture-v1',
    project,
    sdkSourceRevision: fixture.sdkSourceRevision,
    sourceCatalogSha256: fixture.sourceCatalogSha256,
    recipes: [
      {
        tool: 'teamgrid_task_create',
        arguments: {
          workspaceId: workspaceTemplate,
          data: { name: `${namespaceTemplate}-task` },
          idempotencyKey: 'owned-intent-1',
        },
        captures: { taskId: '/data/id' },
        expect: { '/data/type': 'task' },
      },
      {
        tool: 'teamgrid_task_get',
        arguments: { id: taskTemplate },
        captures: {},
        expect: { '/data/id': taskTemplate, '/data/attributes/name': `${project}-task` },
      },
    ],
  }
  fixture.recipeManifestSha256 = sha256(JSON.stringify(manifest))
  const callTool = vi.fn(async () => ({
    structuredContent: {
      data: { id: 'owned-task', type: 'task', attributes: { name: `${project}-task` } },
    },
  }))
  const inspectFixture = vi.fn(async () => structuredClone(fixture))
  const validateInput = vi.fn(async () => true)
  const validateOutput = vi.fn(async () => true)
  const observeEffect = vi.fn(async (binding) => ({
    ...binding,
    completed: true,
    beforeSha256: 'd'.repeat(64),
    afterSha256: 'e'.repeat(64),
    resourceIdSha256: 'f'.repeat(64),
  }))
  const writeIntent = vi.fn(async (binding) => ({ ...binding, beforeSha256: 'd'.repeat(64) }))
  const cleanup = vi.fn(async () => ({
    project,
    customerData: false,
    fixtureRemoved: true,
    grantsRevoked: true,
    runtimeTerminated: true,
  }))
  return {
    manifest,
    catalogBytes,
    fixture,
    callTool,
    inspectFixture,
    validateInput,
    validateOutput,
    observeEffect,
    writeIntent,
    cleanup,
  }
}

describe('complete positive MCP fixture execution', () => {
  it('requires complete inventory coverage of the unchanged published catalog', () => {
    const input = setup()
    input.catalogBytes = readFileSync(
      new URL('../../packages/mcp-server/src/generated/domainCatalog.json', import.meta.url),
    )
    const catalog = JSON.parse(input.catalogBytes)
    input.fixture.sourceCatalogSha256 = sha256(input.catalogBytes)
    input.manifest.sourceCatalogSha256 = input.fixture.sourceCatalogSha256
    // Inventory validation only. These placeholders are never executed and do not
    // claim that the published tools have passed their actual runtime recipes.
    input.manifest.recipes = Object.entries(catalog).map(([tool, definition]) => ({
      tool,
      arguments: definition.write ? { workspaceId: workspaceTemplate } : {},
      captures: {},
      expect: { '/data': null },
    }))
    input.fixture.recipeManifestSha256 = sha256(JSON.stringify(input.manifest))
    expect(validateMcpPositiveRecipes(input)).toHaveLength(Object.keys(catalog).length)
    const originalCount = input.manifest.recipes.length
    input.manifest.recipes[0] = input.manifest.recipes[1]
    input.fixture.recipeManifestSha256 = sha256(JSON.stringify(input.manifest))
    expect(input.manifest.recipes).toHaveLength(originalCount)
    expect(() => validateMcpPositiveRecipes(input)).toThrow('Every published MCP tool')
    expect(input.callTool).not.toHaveBeenCalled()
  })

  it('binds raw catalog bytes and requires every tool exactly once before I/O', async () => {
    const input = setup()
    expect(validateMcpPositiveRecipes(input)).toHaveLength(2)
    input.manifest.recipes.pop()
    input.fixture.recipeManifestSha256 = sha256(JSON.stringify(input.manifest))
    await expect(executeMcpPositiveFixture(input)).rejects.toThrow('Every published MCP tool')
    expect(input.callTool).not.toHaveBeenCalled()
    expect(input.cleanup).not.toHaveBeenCalled()
    const modified = setup()
    modified.catalogBytes += '\n'
    await expect(executeMcpPositiveFixture(modified)).rejects.toThrow('catalog bytes differ')
    const changedRecipe = setup()
    changedRecipe.manifest.recipes[0].arguments.data.name = 'changed'
    await expect(executeMcpPositiveFixture(changedRecipe)).rejects.toThrow('recipe bytes differ')
    expect(changedRecipe.callTool).not.toHaveBeenCalled()
  })

  it.each(['https://mcp.teamgrid.app', 'http://127.0.0.1', 'https://other.teamgrid.app'])(
    'rejects the unowned target %s before transport',
    async (origin) => {
      const input = setup()
      input.fixture.origin = origin
      await expect(executeMcpPositiveFixture(input)).rejects.toThrow('isolation differs')
      expect(input.callTool).not.toHaveBeenCalled()
    },
  )

  it('requires an independent current fixture identity before each tool', async () => {
    const input = setup()
    input.inspectFixture.mockResolvedValue({ ...input.fixture, workspaceId: 'another-workspace' })
    const result = await executeMcpPositiveFixture(input)
    expect(result.executionComplete).toBe(false)
    expect(input.callTool).not.toHaveBeenCalled()
    expect(input.cleanup).toHaveBeenCalledOnce()
  })

  it('journals writes before I/O, checks effect correlation and resolves the later real ID', async () => {
    const input = setup()
    input.callTool.mockImplementation(async () => {
      expect(input.writeIntent).toHaveBeenCalledOnce()
      return {
        structuredContent: {
          data: {
            id: 'owned-task',
            type: 'task',
            attributes: { name: `${input.fixture.project}-task` },
          },
        },
      }
    })
    const result = await executeMcpPositiveFixture(input)
    expect(input.callTool.mock.calls[1][0]).toEqual({
      name: 'teamgrid_task_get',
      arguments: { id: 'owned-task' },
    })
    expect(input.observeEffect).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      executionComplete: true,
      positiveToolCount: 2,
      publishedToolCount: 2,
      cleanupVerified: true,
      runtimeQualificationProduced: false,
      productionDeployment: false,
    })
    expect(JSON.stringify(result)).not.toContain('owned-task')
  })

  it.each([
    { completed: false },
    { afterSha256: 'd'.repeat(64) },
    { workspaceId: 'another-workspace' },
    { operationId: 'anotherOperation' },
    { requestSha256: '0'.repeat(64) },
    { responseSha256: '0'.repeat(64) },
    { resourceIdSha256: 'not-a-digest' },
  ])('rejects an absent, queued or misbound effect: %j', async (changes) => {
    const input = setup()
    input.observeEffect.mockImplementation(async (binding) => ({
      ...binding,
      completed: true,
      beforeSha256: 'd'.repeat(64),
      afterSha256: 'e'.repeat(64),
      resourceIdSha256: 'f'.repeat(64),
      ...changes,
    }))
    const result = await executeMcpPositiveFixture(input)
    expect(result.executionComplete).toBe(false)
    expect(result.results.map((row) => row.outcome)).toEqual(['failed', 'not_run'])
    expect(input.callTool).toHaveBeenCalledOnce()
  })

  it('never retries an uncertain mutation or leaks its private error', async () => {
    const input = setup()
    input.callTool.mockRejectedValue(new Error('private-token-and-contact-address'))
    const result = await executeMcpPositiveFixture(input)
    expect(input.callTool).toHaveBeenCalledOnce()
    expect(input.cleanup).toHaveBeenCalledOnce()
    expect(result.executionComplete).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private-token-and-contact-address')
  })

  it('rejects invalid arguments and an unbound pre-state before journaling or transport', async () => {
    const invalid = setup()
    invalid.validateInput.mockResolvedValue(false)
    expect((await executeMcpPositiveFixture(invalid)).executionComplete).toBe(false)
    expect(invalid.writeIntent).not.toHaveBeenCalled()
    expect(invalid.callTool).not.toHaveBeenCalled()
    const unbound = setup()
    unbound.writeIntent.mockImplementation(async (binding) => ({
      ...binding,
      workspaceId: 'foreign',
      beforeSha256: 'd'.repeat(64),
    }))
    expect((await executeMcpPositiveFixture(unbound)).executionComplete).toBe(false)
    expect(unbound.callTool).not.toHaveBeenCalled()
  })

  it('rejects successful-looking responses that violate the schema or expected data', async () => {
    const invalidSchema = setup()
    invalidSchema.validateOutput.mockResolvedValue(false)
    expect((await executeMcpPositiveFixture(invalidSchema)).executionComplete).toBe(false)
    const wrongData = setup()
    wrongData.callTool.mockResolvedValue({
      structuredContent: { data: { type: 'other', id: 'x' } },
    })
    expect((await executeMcpPositiveFixture(wrongData)).executionComplete).toBe(false)
    expect(wrongData.observeEffect).not.toHaveBeenCalled()
  })

  it('does not count documented unavailable or denied errors as positive coverage', async () => {
    const input = setup()
    input.callTool.mockResolvedValue({
      isError: true,
      structuredContent: { error: { status: 501, code: 'unavailable' } },
    })
    const result = await executeMcpPositiveFixture(input)
    expect(result.positiveToolCount).toBe(0)
    expect(result.executionComplete).toBe(false)
  })

  it('requires runtime termination and grant cleanup even after all tools pass', async () => {
    const input = setup()
    input.cleanup.mockResolvedValue({
      project: input.fixture.project,
      customerData: false,
      fixtureRemoved: true,
      grantsRevoked: true,
      runtimeTerminated: false,
    })
    const result = await executeMcpPositiveFixture(input)
    expect(result.positiveToolCount).toBe(2)
    expect(result.executionComplete).toBe(false)
    expect(result.cleanupVerified).toBe(false)
  })

  it('rejects a foreign write or unresolved capture before any operation', async () => {
    const foreign = setup()
    foreign.manifest.recipes[0].arguments.workspaceId = 'another-workspace'
    foreign.fixture.recipeManifestSha256 = sha256(JSON.stringify(foreign.manifest))
    await expect(executeMcpPositiveFixture(foreign)).rejects.toThrow('another workspace')
    expect(foreign.callTool).not.toHaveBeenCalled()
    const future = setup()
    future.manifest.recipes[0].arguments.data.name = taskTemplate
    future.fixture.recipeManifestSha256 = sha256(JSON.stringify(future.manifest))
    await expect(executeMcpPositiveFixture(future)).rejects.toThrow('unresolved dependency')
    expect(future.callTool).not.toHaveBeenCalled()
  })

  it('rejects an expired fixture before I/O and a fixture that expires between operations', async () => {
    const input = setup()
    input.fixture.deadline = new Date(Date.now() - 1).toISOString()
    await expect(executeMcpPositiveFixture(input)).rejects.toThrow('expired')
    expect(input.callTool).not.toHaveBeenCalled()
    const expires = setup()
    let current = Date.now()
    expires.now = () => current
    expires.observeEffect.mockImplementation(async (binding) => {
      current = Date.parse(expires.fixture.deadline)
      return {
        ...binding,
        completed: true,
        beforeSha256: 'd'.repeat(64),
        afterSha256: 'e'.repeat(64),
        resourceIdSha256: 'f'.repeat(64),
      }
    })
    const result = await executeMcpPositiveFixture(expires)
    expect(result.executionComplete).toBe(false)
    expect(input.callTool).not.toHaveBeenCalled()
    expect(expires.callTool).toHaveBeenCalledOnce()
    expect(expires.cleanup).toHaveBeenCalledOnce()
  })

  it('cancels a stalled mutation, never retries it and still terminates the fixture', async () => {
    vi.useFakeTimers()
    try {
      const input = setup()
      let signal
      input.callTool.mockImplementation((_request, options) => {
        signal = options.signal
        return new Promise(() => {})
      })
      const pending = executeMcpPositiveFixture(input)
      await vi.advanceTimersByTimeAsync(30001)
      const result = await pending
      expect(signal.aborted).toBe(true)
      expect(input.callTool).toHaveBeenCalledOnce()
      expect(input.cleanup).toHaveBeenCalledOnce()
      expect(result.results.map((row) => row.outcome)).toEqual(['failed', 'not_run'])
      expect(result.executionComplete).toBe(false)
      expect(result.cleanupVerified).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

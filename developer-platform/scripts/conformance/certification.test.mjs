import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executePositiveCertification, loadCertificationRecipes } from './certification.mjs'

const operations = [
  {
    authenticated: true,
    idempotencyRequired: true,
    ifMatchRequired: false,
    method: 'POST',
    operationId: 'createTask',
    path: '/tasks',
    requestBodyRequired: true,
    requiredParameters: [],
    responseStatuses: ['201', '400'],
    risk: 'mutation',
    version: 'v1',
  },
  {
    authenticated: true,
    idempotencyRequired: false,
    ifMatchRequired: false,
    method: 'DELETE',
    operationId: 'archiveTask',
    path: '/tasks/{id}',
    requestBodyRequired: false,
    requiredParameters: [{ location: 'path', name: 'id', required: true }],
    responseStatuses: ['204', '404'],
    risk: 'destructive-mutation',
    version: 'v1',
  },
]
const taskIdTemplate = `\${taskId}`
const fixtureNamespaceTemplate = `\${fixtureNamespace}`

function recipeManifest() {
  return {
    fixtureNamespace: 'codex-conformance-acme-01',
    inventoryDigest: 'a'.repeat(64),
    recipeContract: 'teamgrid-positive-fixture-recipes-v1',
    recipes: [
      {
        captures: { taskId: { jsonPointer: '/data/id' } },
        cleanup: {
          operationId: 'archiveTask',
          pathParameters: { id: taskIdTemplate },
          resourceId: taskIdTemplate,
          resourceType: 'task',
        },
        expectedStatuses: [201],
        fixtureBound: true,
        operationId: 'createTask',
        request: { body: { name: fixtureNamespaceTemplate }, pathParameters: {} },
      },
      {
        cleanupNotRequiredReason: 'This operation is the fixture cleanup action itself.',
        expectedStatuses: [204],
        fixtureBound: true,
        operationId: 'archiveTask',
        request: { pathParameters: { id: taskIdTemplate } },
      },
    ],
    schemaVersion: 1,
  }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'teamgrid-certification-'))
  const recipePath = join(directory, 'recipes.json')
  const cleanupJournalPath = join(directory, 'cleanup.json')
  writeFileSync(recipePath, JSON.stringify(recipeManifest()))
  const inventory = {
    inventoryDigest: 'a'.repeat(64),
    operations,
  }
  const config = {
    cleanupJournalPath,
    fixtureNamespace: 'codex-conformance-acme-01',
    mode: 'certification',
    requestIntervalMs: 250,
    requestTimeoutMs: 1_000,
    runId: 'tg-conformance-run-1',
    secrets: { TEAMGRID_CONFORMANCE_V1_TOKEN: 'synthetic-test-secret' },
    target: { v1BaseUrl: 'https://api.de.teamgrid.app/v1' },
    versions: ['v1'],
  }
  return { cleanupJournalPath, config, inventory, recipePath }
}

describe('isolated positive certification', () => {
  it('requires complete, digest-bound recipes before sending a request', async () => {
    const { config, inventory, recipePath } = setup()
    await expect(
      loadCertificationRecipes(recipePath, {
        fixtureNamespace: config.fixtureNamespace,
        inventory,
      }),
    ).resolves.toHaveLength(2)

    const invalid = recipeManifest()
    invalid.recipes.pop()
    writeFileSync(recipePath, JSON.stringify(invalid))
    await expect(
      loadCertificationRecipes(recipePath, {
        fixtureNamespace: config.fixtureNamespace,
        inventory,
      }),
    ).rejects.toThrow('cover every v1 operation exactly once')
  })

  it('journals an idempotent creation before transport and reconciles an ambiguous outcome', async () => {
    const { cleanupJournalPath, config, inventory, recipePath } = setup()
    const recipes = await loadCertificationRecipes(recipePath, {
      fixtureNamespace: config.fixtureNamespace,
      inventory,
    })
    let createAttempts = 0
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(input)
      if (init.method === 'POST') {
        createAttempts += 1
        expect(new Headers(init.headers).get('idempotency-key')).toBe(
          'codex-conformance-acme-01-createTask',
        )
        if (createAttempts === 1) throw new Error('ambiguous transport failure')
        return new Response(JSON.stringify({ data: { id: 'task-1', type: 'task' } }), {
          headers: { 'content-type': 'application/json', 'x-request-id': 'create-request' },
          status: 201,
        })
      }
      expect(url.pathname).toBe('/v1/tasks/task-1')
      return new Response(null, { status: 204 })
    })

    const results = await executePositiveCertification({
      config,
      fetchImpl,
      inventory,
      recipes,
      sleep: async () => {},
    })

    expect(results).toMatchObject([
      { operationId: 'createTask', outcome: 'failed' },
      { operationId: 'archiveTask', outcome: 'not_run' },
    ])
    expect(createAttempts).toBe(2)
    const journal = JSON.parse(readFileSync(cleanupJournalPath, 'utf8'))
    expect(journal).toMatchObject({
      mutationIntents: [{ operationId: 'createTask', state: 'resolved' }],
      resources: [{ resourceId: 'task-1', state: 'cleaned' }],
      state: 'complete',
    })
    expect(JSON.stringify(journal)).not.toContain('synthetic-test-secret')
  })
})

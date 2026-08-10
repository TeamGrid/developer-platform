import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executePositiveCertification,
  loadCertificationRecipes,
  recoverPositiveCertification,
} from './certification.mjs'
import { hydrateConformanceCredentials, knownSecrets, resolveConformanceConfig } from './config.mjs'
import { buildConformanceEvidence, writeConformanceEvidence } from './evidence.mjs'
import { buildConformanceInventory, formatInventorySummary } from './inventory.mjs'
import { executeReadOnlyConformance } from './read-only.mjs'
import { executeRouteSmokeConformance } from './route-smoke.mjs'
import { executeSafeMutationSmokeConformance } from './safe-mutation-smoke.mjs'
import { executeSurfaceConformance } from './surfaces.mjs'

function parseArguments(arguments_) {
  const result = { format: 'text', mode: undefined, output: undefined, recover: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--format') result.format = arguments_[++index]
    else if (argument === '--mode') result.mode = arguments_[++index]
    else if (argument === '--output') result.output = arguments_[++index]
    else if (argument === '--recover') result.recover = true
    else throw new Error(`Unknown conformance argument: ${argument}`)
  }
  if (!['json', 'text'].includes(result.format)) {
    throw new Error('--format must be json or text.')
  }
  return result
}

function formatRunSummary(evidence) {
  const outcomes = evidence.summary.byOutcome
  return [
    `TeamGrid production conformance: ${evidence.result}`,
    `${evidence.summary.total} operations classified`,
    `${outcomes.passed || 0} passed; ${outcomes.failed || 0} failed; ${outcomes.blocked || 0} blocked`,
    `Evidence: ${evidence.runId}`,
  ].join('\n')
}

export async function runConformance({
  arguments_: argumentsValue = process.argv.slice(2),
  environment = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep,
} = {}) {
  const arguments_ = parseArguments(argumentsValue)
  let config = resolveConformanceConfig({
    environment,
    mode: arguments_.mode,
    now: now(),
  })

  const inventory = await buildConformanceInventory()
  if (
    config.mode === 'certification' ||
    config.mode === 'read-only' ||
    config.mode === 'route-smoke' ||
    config.mode === 'safe-mutation-smoke'
  ) {
    config = await hydrateConformanceCredentials(config)
    const recipes =
      config.mode === 'certification'
        ? await loadCertificationRecipes(config.recipePath, {
            fixtureNamespace: config.fixtureNamespace,
            inventory,
          })
        : undefined
    if (arguments_.recover) {
      if (config.mode !== 'certification') {
        throw new Error('--recover is supported only in certification mode.')
      }
      await recoverPositiveCertification({ config, fetchImpl, inventory, now, recipes })
      return arguments_.format === 'json'
        ? `${JSON.stringify({ mode: config.mode, recovered: true }, null, 2)}\n`
        : 'TeamGrid positive certification cleanup recovered successfully.\n'
    }
    const startedAt = now().toISOString()
    const results =
      config.mode === 'certification'
        ? await executePositiveCertification({
            config,
            fetchImpl,
            inventory,
            now,
            recipes,
            ...(sleep ? { sleep } : {}),
          })
        : config.mode === 'safe-mutation-smoke'
          ? await executeSafeMutationSmokeConformance({
              config,
              fetchImpl,
              inventory,
              now,
              ...(sleep ? { sleep } : {}),
            })
          : config.mode === 'read-only'
            ? await executeReadOnlyConformance({
                config,
                fetchImpl,
                inventory,
                ...(sleep ? { sleep } : {}),
              })
            : await executeRouteSmokeConformance({
                config,
                fetchImpl,
                inventory,
                ...(sleep ? { sleep } : {}),
              })
    if (config.versions.includes('v1')) {
      results.push(
        ...(await executeSurfaceConformance({
          config,
          inventory,
          ...(sleep ? { sleep } : {}),
        })),
      )
    }
    const evidence = buildConformanceEvidence({
      completedAt: now().toISOString(),
      config,
      inventory,
      results,
      startedAt,
    })
    writeConformanceEvidence(config.evidencePath, evidence, {
      secrets: knownSecrets(config),
    })
    return arguments_.format === 'json'
      ? `${JSON.stringify(evidence, null, 2)}\n`
      : `${formatRunSummary(evidence)}\n`
  }

  if (arguments_.recover) throw new Error('--recover requires certification mode.')

  const payload = {
    contractVersion: inventory.contractVersion,
    contracts: inventory.contracts,
    inventoryDigest: inventory.inventoryDigest,
    mode: config.mode,
    operations: inventory.operations,
    schemaVersion: inventory.schemaVersion,
    summary: inventory.summary,
  }
  const rendered =
    arguments_.format === 'json'
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${formatInventorySummary(inventory)}\n`

  if (arguments_.output) {
    await writeFile(resolve(arguments_.output), rendered, { encoding: 'utf8', mode: 0o600 })
  }
  return rendered
}

export const runConformancePlan = runConformance

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  process.stdout.write(await runConformance())
}

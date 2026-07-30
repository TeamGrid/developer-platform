import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const modes = new Set(['certification', 'plan', 'read-only', 'route-smoke', 'safe-mutation-smoke'])
const regions = new Set(['de', 'us'])
const productionTargets = {
  v0: new Set(['https://api.teamgrid.app', 'https://api.teamgridapp.com']),
  v1: new Set([
    'https://api.de.teamgrid.app/v1',
    'https://api.teamgrid.app/v1',
    'https://api.us.teamgrid.app/v1',
  ]),
}

function value(environment, name) {
  return String(environment[name] || '').trim()
}

function required(environment, name) {
  const result = value(environment, name)
  if (!result) throw new Error(`${name} is required.`)
  return result
}

function exactBoolean(environment, name) {
  const result = value(environment, name)
  if (result && !['false', 'true'].includes(result)) {
    throw new Error(`${name} must be true or false.`)
  }
  return result === 'true'
}

function normalizedBaseUrl(rawValue, name) {
  let url
  try {
    url = new URL(rawValue)
  } catch {
    throw new Error(`${name} must be an absolute URL.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function assertProductionTarget(kind, target) {
  if (!productionTargets[kind].has(target)) {
    throw new Error(
      `TEAMGRID_CONFORMANCE_${kind.toUpperCase()}_BASE_URL is not a canonical production target.`,
    )
  }
}

function boundedInteger(environment, name, fallback, minimum, maximum) {
  const rawValue = value(environment, name)
  if (!rawValue) return fallback
  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
}

function selectedVersions(environment) {
  const requested = value(environment, 'TEAMGRID_CONFORMANCE_VERSIONS') || 'v0,v1'
  const versions = requested.split(',').map((version) => version.trim())
  if (
    versions.length === 0 ||
    new Set(versions).size !== versions.length ||
    versions.some((version) => !['v0', 'v1'].includes(version))
  ) {
    throw new Error('TEAMGRID_CONFORMANCE_VERSIONS must be v0, v1, or v0,v1.')
  }
  return ['v0', 'v1'].filter((version) => versions.includes(version))
}

export function resolveConformanceConfig({
  environment = process.env,
  mode: modeOverride,
  now = new Date(),
  runId = randomUUID(),
} = {}) {
  const mode = modeOverride || value(environment, 'TEAMGRID_CONFORMANCE_MODE') || 'plan'
  if (!modes.has(mode)) {
    throw new Error(
      'TEAMGRID_CONFORMANCE_MODE must be plan, read-only, route-smoke, safe-mutation-smoke, or certification.',
    )
  }

  const base = {
    evidencePath: value(environment, 'TEAMGRID_CONFORMANCE_EVIDENCE_PATH')
      ? resolve(value(environment, 'TEAMGRID_CONFORMANCE_EVIDENCE_PATH'))
      : undefined,
    mode,
    pageLimit: boundedInteger(environment, 'TEAMGRID_CONFORMANCE_PAGE_LIMIT', 1, 1, 100),
    requestIntervalMs: boundedInteger(
      environment,
      'TEAMGRID_CONFORMANCE_REQUEST_INTERVAL_MS',
      350,
      250,
      5_000,
    ),
    requestTimeoutMs: boundedInteger(
      environment,
      'TEAMGRID_CONFORMANCE_REQUEST_TIMEOUT_MS',
      10_000,
      1_000,
      30_000,
    ),
    runId: `tg-conformance-${now.toISOString().replaceAll(/[-:.]/g, '')}-${runId}`,
    target: null,
    versions: selectedVersions(environment),
  }
  if (mode === 'plan') return { ...base, secrets: null }

  const region = required(environment, 'TEAMGRID_CONFORMANCE_REGION')
  if (!regions.has(region)) throw new Error('TEAMGRID_CONFORMANCE_REGION must be de or us.')
  if (!exactBoolean(environment, 'TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION')) {
    throw new Error('TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION=true is required for live checks.')
  }

  const v0BaseUrl = base.versions.includes('v0')
    ? normalizedBaseUrl(
        required(environment, 'TEAMGRID_CONFORMANCE_V0_BASE_URL'),
        'TEAMGRID_CONFORMANCE_V0_BASE_URL',
      )
    : undefined
  const v1BaseUrl = base.versions.includes('v1')
    ? normalizedBaseUrl(
        required(environment, 'TEAMGRID_CONFORMANCE_V1_BASE_URL'),
        'TEAMGRID_CONFORMANCE_V1_BASE_URL',
      )
    : undefined
  if (v0BaseUrl) assertProductionTarget('v0', v0BaseUrl)
  if (v1BaseUrl) assertProductionTarget('v1', v1BaseUrl)
  if (
    v1BaseUrl &&
    v1BaseUrl !== 'https://api.teamgrid.app/v1' &&
    !v1BaseUrl.startsWith(`https://api.${region}.teamgrid.app/`)
  ) {
    throw new Error('TEAMGRID_CONFORMANCE_REGION and TEAMGRID_CONFORMANCE_V1_BASE_URL disagree.')
  }

  const credentialProfiles = {
    ...(base.versions.includes('v0') && value(environment, 'TEAMGRID_CONFORMANCE_V0_PROFILE')
      ? { v0: value(environment, 'TEAMGRID_CONFORMANCE_V0_PROFILE') }
      : {}),
    ...(base.versions.includes('v1') && value(environment, 'TEAMGRID_CONFORMANCE_V1_PROFILE')
      ? { v1: value(environment, 'TEAMGRID_CONFORMANCE_V1_PROFILE') }
      : {}),
  }
  const secrets = {
    ...(base.versions.includes('v0') && !credentialProfiles.v0
      ? { TEAMGRID_CONFORMANCE_V0_TOKEN: required(environment, 'TEAMGRID_CONFORMANCE_V0_TOKEN') }
      : {}),
    ...(base.versions.includes('v1') && !credentialProfiles.v1
      ? { TEAMGRID_CONFORMANCE_V1_TOKEN: required(environment, 'TEAMGRID_CONFORMANCE_V1_TOKEN') }
      : {}),
  }
  if (
    Object.values(credentialProfiles).some(
      (profile) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile),
    )
  ) {
    throw new Error('A TeamGrid conformance credential profile is malformed.')
  }
  if (
    secrets.TEAMGRID_CONFORMANCE_V0_TOKEN &&
    secrets.TEAMGRID_CONFORMANCE_V1_TOKEN &&
    secrets.TEAMGRID_CONFORMANCE_V0_TOKEN === secrets.TEAMGRID_CONFORMANCE_V1_TOKEN
  ) {
    throw new Error('V0 and V1 conformance credentials must be distinct.')
  }
  if (!base.evidencePath) {
    throw new Error('TEAMGRID_CONFORMANCE_EVIDENCE_PATH is required for live checks.')
  }

  if (mode === 'certification' || mode === 'safe-mutation-smoke') {
    if (!exactBoolean(environment, 'TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS')) {
      throw new Error(
        'TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS=true is required for mutation conformance.',
      )
    }
    const fixtureNamespace = required(environment, 'TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE')
    if (!/^codex-conformance-[a-z0-9-]{6,48}$/.test(fixtureNamespace)) {
      throw new Error('TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE must start with codex-conformance-.')
    }
    const cleanupJournalPath = resolve(
      required(environment, 'TEAMGRID_CONFORMANCE_CLEANUP_JOURNAL_PATH'),
    )
    if (cleanupJournalPath === base.evidencePath) {
      throw new Error('Cleanup journal and conformance evidence paths must be distinct.')
    }
    return {
      ...base,
      cleanupJournalPath,
      credentialProfiles,
      fixtureNamespace,
      secrets,
      target: { region, v0BaseUrl, v1BaseUrl },
    }
  }

  return {
    ...base,
    credentialProfiles,
    secrets,
    target: { region, v0BaseUrl, v1BaseUrl },
  }
}

export function redactedConfig(config) {
  return {
    ...(config.cleanupJournalPath ? { cleanupJournalPath: config.cleanupJournalPath } : {}),
    credentialProfiles: config.credentialProfiles,
    evidencePath: config.evidencePath,
    ...(config.fixtureNamespace ? { fixtureNamespace: config.fixtureNamespace } : {}),
    mode: config.mode,
    pageLimit: config.pageLimit,
    requestIntervalMs: config.requestIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    runId: config.runId,
    target: config.target,
    versions: config.versions,
  }
}

export function knownSecrets(config) {
  return Object.values(config.secrets || {}).filter(Boolean)
}

export async function hydrateConformanceCredentials(
  config,
  {
    credentialStoreLoader = async () => {
      const { SystemCredentialStore } = await import('../../packages/cli/dist/index.js')
      return new SystemCredentialStore()
    },
  } = {},
) {
  if (!config.credentialProfiles || Object.keys(config.credentialProfiles).length === 0)
    return config
  const credentialStore = await credentialStoreLoader()
  const secrets = { ...config.secrets }
  for (const [version, profile] of Object.entries(config.credentialProfiles)) {
    const token = await credentialStore.get(profile)
    if (!token)
      throw new Error(`The configured ${version.toUpperCase()} profile has no credential.`)
    secrets[version === 'v0' ? 'TEAMGRID_CONFORMANCE_V0_TOKEN' : 'TEAMGRID_CONFORMANCE_V1_TOKEN'] =
      token
  }
  if (
    secrets.TEAMGRID_CONFORMANCE_V0_TOKEN &&
    secrets.TEAMGRID_CONFORMANCE_V1_TOKEN &&
    secrets.TEAMGRID_CONFORMANCE_V0_TOKEN === secrets.TEAMGRID_CONFORMANCE_V1_TOKEN
  ) {
    throw new Error('V0 and V1 conformance credentials must be distinct.')
  }
  return {
    ...config,
    secrets,
  }
}

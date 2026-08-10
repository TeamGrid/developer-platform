import {
  buildRegionalApiBaseUrl,
  normalizeApiBaseUrl,
  parseCredentialLocation,
  redactDeveloperSecrets,
  TeamGridApiError,
  type TeamGridClient,
  TeamGridClientError,
  type TeamGridClientOptions,
} from '@teamgrid/api-client'
import {
  type CliConfig,
  type ConfigStore,
  cliProfileCredentialValidity,
  normalizeProfileName,
} from './config.js'
import type { CredentialStore } from './credentialStore.js'
import { sanitizeTerminalText } from './output.js'

export type DoctorCheck = {
  check:
    | 'api-capabilities'
    | 'api-compatibility'
    | 'base-url'
    | 'configuration'
    | 'credential'
    | 'network'
  detail: string
  diagnostics?: {
    code?: string
    requestId?: string
    retryAfterMs?: number
    status?: number
  }
  status: 'fail' | 'pass' | 'skipped' | 'warn'
}

export type DoctorReport = {
  api?: {
    capabilityCount?: number
    contractVersion?: string
    region?: string | null
    requestId?: string
    supportedCliMajor?: number
    version?: string
  }
  baseUrl?: string
  checks: DoctorCheck[]
  credentialSource: 'TEAMGRID_API_TOKEN' | 'keychain' | 'none'
  location?: {
    cellId: string
    credentialId: string
    region: string
  }
  ok: boolean
  profile: string
}

type DoctorClient = Pick<TeamGridClient, 'system'>

export type DoctorDependencies = {
  baseUrl?: string
  clientFactory: (options: TeamGridClientOptions) => DoctorClient
  configStore: ConfigStore
  credentialStore: CredentialStore
  environment: NodeJS.ProcessEnv
  now: Date
  packageVersion: string
  profile?: string
  retries: number
  timeoutMs: number
}

function safeDetail(value: string) {
  return sanitizeTerminalText(redactDeveloperSecrets(value)).slice(0, 512)
}

function diagnostics(error: unknown): DoctorCheck['diagnostics'] {
  if (error instanceof TeamGridApiError) {
    const code = error.errors[0]?.code
    const retryAfterMs =
      error.retryAfterMs !== undefined &&
      Number.isFinite(error.retryAfterMs) &&
      error.retryAfterMs >= 0
        ? Math.min(error.retryAfterMs, 30_000)
        : undefined
    const status =
      Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? error.status
        : undefined
    return {
      ...(typeof code === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(code) ? { code } : {}),
      ...(error.requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(error.requestId)
        ? { requestId: error.requestId }
        : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(status === undefined ? {} : { status }),
    }
  }
  if (error instanceof TeamGridClientError) {
    return {
      code: /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code) ? error.code : 'teamgrid_client_error',
    }
  }
  return undefined
}

function failureDetail(error: unknown, fallback: string) {
  if (error instanceof TeamGridApiError) {
    const code = diagnostics(error)?.code || 'api_error'
    const status = diagnostics(error)?.status
    return `TeamGrid API rejected the diagnostic request with ${code}${status ? ` (HTTP ${status})` : ''}.`
  }
  if (error instanceof TeamGridClientError) {
    const details: Record<string, string> = {
      credential_expired: 'The selected credential has expired.',
      credential_store_unavailable: 'The operating-system credential store is unavailable.',
      invalid_api_response: 'The endpoint returned an invalid TeamGrid API response.',
      network_error: 'The TeamGrid API endpoint could not be reached.',
      request_aborted: 'The TeamGrid API diagnostic request was aborted.',
      request_timeout: 'The TeamGrid API diagnostic request timed out.',
    }
    return details[error.code] || fallback
  }
  return fallback
}

function apiExitCode(error: unknown) {
  if (error instanceof TeamGridApiError) {
    return ({ 401: 3, 403: 4, 429: 7 } as Record<number, number>)[error.status] || 1
  }
  return 1
}

function compareVersions(left: string, right: string) {
  const parts = (value: string) => value.split('.').map((part) => Number(part) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference) return difference
  }
  return 0
}

function result(
  report: Omit<DoctorReport, 'checks' | 'ok'>,
  checks: DoctorCheck[],
  exitCode: number,
) {
  return { exitCode, report: { ...report, checks, ok: exitCode === 0 } satisfies DoctorReport }
}

function skipRemoteChecks(checks: DoctorCheck[], reason: string) {
  for (const check of ['network', 'api-compatibility', 'api-capabilities'] as const) {
    checks.push({ check, detail: reason, status: 'skipped' })
  }
}

export async function runDoctorChecks(dependencies: DoctorDependencies) {
  const checks: DoctorCheck[] = []
  let config: CliConfig
  let profile = dependencies.profile || 'default'
  try {
    config = await dependencies.configStore.load()
    profile = dependencies.profile
      ? normalizeProfileName(dependencies.profile)
      : config.currentProfile || 'default'
    checks.push({
      check: 'configuration',
      detail: `CLI configuration loaded; selected profile is '${safeDetail(profile)}'.`,
      status: 'pass',
    })
  } catch (error) {
    checks.push({
      check: 'configuration',
      detail: failureDetail(error, 'The TeamGrid CLI configuration could not be loaded.'),
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    checks.push({
      check: 'credential',
      detail: 'Skipped because configuration is invalid.',
      status: 'skipped',
    })
    checks.push({
      check: 'base-url',
      detail: 'Skipped because configuration is invalid.',
      status: 'skipped',
    })
    skipRemoteChecks(checks, 'Skipped because local configuration checks failed.')
    return result({ credentialSource: 'none', profile }, checks, 2)
  }

  const localProfile = config.profiles[profile]
  const environmentToken = String(dependencies.environment.TEAMGRID_API_TOKEN || '').trim()
  let token = environmentToken
  let credentialSource: DoctorReport['credentialSource'] = environmentToken
    ? 'TEAMGRID_API_TOKEN'
    : 'none'
  if (!token) {
    try {
      token = (await dependencies.credentialStore.get(profile)) || ''
      if (token) credentialSource = 'keychain'
    } catch (error) {
      checks.push({
        check: 'credential',
        detail: failureDetail(error, 'The selected credential could not be read.'),
        diagnostics: diagnostics(error),
        status: 'fail',
      })
      checks.push({
        check: 'base-url',
        detail: 'Skipped because no credential is available.',
        status: 'skipped',
      })
      skipRemoteChecks(checks, 'Skipped because local credential checks failed.')
      return result({ credentialSource, profile }, checks, 2)
    }
  }
  if (!token) {
    checks.push({
      check: 'credential',
      detail: `No credential is available for profile '${safeDetail(profile)}'.`,
      diagnostics: { code: 'authentication_required' },
      status: 'fail',
    })
    checks.push({
      check: 'base-url',
      detail: 'Skipped because no credential is available.',
      status: 'skipped',
    })
    skipRemoteChecks(checks, 'Skipped because local credential checks failed.')
    return result({ credentialSource, profile }, checks, 3)
  }

  let location: DoctorReport['location']
  try {
    location = parseCredentialLocation(token)
  } catch (error) {
    checks.push({
      check: 'credential',
      detail: 'The selected credential does not use a supported TeamGrid token format.',
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    checks.push({
      check: 'base-url',
      detail: 'Skipped because credential routing is invalid.',
      status: 'skipped',
    })
    skipRemoteChecks(checks, 'Skipped because local credential checks failed.')
    return result({ credentialSource, profile }, checks, 3)
  }

  if (
    !environmentToken &&
    localProfile &&
    (localProfile.credentialId !== location.credentialId ||
      localProfile.cellId !== location.cellId ||
      localProfile.region !== location.region)
  ) {
    checks.push({
      check: 'credential',
      detail: 'The keychain credential does not match the selected profile routing metadata.',
      diagnostics: { code: 'profile_credential_mismatch' },
      status: 'fail',
    })
    checks.push({
      check: 'base-url',
      detail: 'Skipped because credential metadata is inconsistent.',
      status: 'skipped',
    })
    skipRemoteChecks(checks, 'Skipped because local credential checks failed.')
    return result({ credentialSource, location, profile }, checks, 3)
  }

  const validity = environmentToken
    ? 'unknown'
    : cliProfileCredentialValidity(localProfile, dependencies.now)
  if (validity === 'expired') {
    checks.push({
      check: 'credential',
      detail: `The credential for profile '${safeDetail(profile)}' expired at ${safeDetail(localProfile?.expiresAt || '')}.`,
      diagnostics: { code: 'credential_expired' },
      status: 'fail',
    })
    checks.push({
      check: 'base-url',
      detail: 'Skipped because the credential expired.',
      status: 'skipped',
    })
    skipRemoteChecks(checks, 'Skipped because local credential checks failed.')
    return result({ credentialSource, location, profile }, checks, 3)
  }
  checks.push({
    check: 'credential',
    detail:
      validity === 'expiring-soon'
        ? `Credential is valid but expires soon at ${safeDetail(localProfile?.expiresAt || '')}.`
        : `Credential is available from ${credentialSource}; region '${safeDetail(location.region)}', cell '${safeDetail(location.cellId)}'.`,
    status: validity === 'expiring-soon' ? 'warn' : 'pass',
  })

  let baseUrl: string
  try {
    baseUrl = normalizeApiBaseUrl(
      dependencies.baseUrl ||
        (!environmentToken ? localProfile?.baseUrl : undefined) ||
        buildRegionalApiBaseUrl(location.region),
    )
    checks.push({
      check: 'base-url',
      detail: `Resolved API base URL is ${safeDetail(baseUrl)}.`,
      status: 'pass',
    })
  } catch (error) {
    checks.push({
      check: 'base-url',
      detail: failureDetail(error, 'The resolved API base URL is invalid.'),
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    skipRemoteChecks(checks, 'Skipped because API routing is invalid.')
    return result({ credentialSource, location, profile }, checks, 2)
  }

  let client: DoctorClient
  try {
    client = dependencies.clientFactory({
      baseUrl,
      retries: dependencies.retries,
      timeoutMs: dependencies.timeoutMs,
      token,
    })
  } catch (error) {
    checks.push({
      check: 'network',
      detail: failureDetail(error, 'The TeamGrid API client could not be initialized.'),
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    checks.push({
      check: 'api-compatibility',
      detail: 'Skipped because the API client could not be initialized.',
      status: 'skipped',
    })
    checks.push({
      check: 'api-capabilities',
      detail: 'Skipped because the API client could not be initialized.',
      status: 'skipped',
    })
    return result({ baseUrl, credentialSource, location, profile }, checks, 1)
  }
  let discovery: Awaited<ReturnType<DoctorClient['system']['getApiVersion']>>
  try {
    discovery = await client.system.getApiVersion()
    checks.push({
      check: 'network',
      detail: `Reached TeamGrid API v${safeDetail(discovery.data.version)} in ${safeDetail(discovery.transport.attempts.toString())} attempt(s).`,
      status: 'pass',
    })
  } catch (error) {
    checks.push({
      check: 'network',
      detail: failureDetail(error, 'The TeamGrid API network check failed.'),
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    checks.push({
      check: 'api-compatibility',
      detail: 'Skipped because the API endpoint was not reached.',
      status: 'skipped',
    })
    checks.push({
      check: 'api-capabilities',
      detail: 'Skipped because the API endpoint was not reached.',
      status: 'skipped',
    })
    return result({ baseUrl, credentialSource, location, profile }, checks, apiExitCode(error))
  }

  const compatibility = discovery.data.supportedClients.cli
  const packageMajor = Number(dependencies.packageVersion.split('.')[0])
  const compatible =
    compatibility.supportedMajor === packageMajor &&
    compareVersions(dependencies.packageVersion, compatibility.minimumVersion) >= 0
  checks.push({
    check: 'api-compatibility',
    detail: compatible
      ? `CLI ${safeDetail(dependencies.packageVersion)} satisfies API minimum ${safeDetail(compatibility.minimumVersion)} and supported major ${compatibility.supportedMajor}.`
      : `CLI ${safeDetail(dependencies.packageVersion)} is incompatible with API minimum ${safeDetail(compatibility.minimumVersion)} and supported major ${compatibility.supportedMajor}.`,
    status: compatible ? 'pass' : 'fail',
  })
  if (!compatible) {
    checks.push({
      check: 'api-capabilities',
      detail: 'Skipped because API and CLI versions are incompatible.',
      status: 'skipped',
    })
    return result(
      {
        api: {
          contractVersion: discovery.data.contractVersion,
          region: discovery.data.region,
          requestId: discovery.meta.requestId,
          supportedCliMajor: compatibility.supportedMajor,
          version: discovery.data.version,
        },
        baseUrl,
        credentialSource,
        location,
        profile,
      },
      checks,
      1,
    )
  }

  try {
    const capabilities = await client.system.getCapabilities()
    checks.push({
      check: 'api-capabilities',
      detail: `Authenticated capability discovery returned ${capabilities.data.length} entries.`,
      status: 'pass',
    })
    return result(
      {
        api: {
          capabilityCount: capabilities.data.length,
          contractVersion: discovery.data.contractVersion,
          region: discovery.data.region,
          requestId: capabilities.meta.requestId,
          supportedCliMajor: compatibility.supportedMajor,
          version: discovery.data.version,
        },
        baseUrl,
        credentialSource,
        location,
        profile,
      },
      checks,
      0,
    )
  } catch (error) {
    checks.push({
      check: 'api-capabilities',
      detail: failureDetail(error, 'Authenticated API capability discovery failed.'),
      diagnostics: diagnostics(error),
      status: 'fail',
    })
    return result(
      {
        api: {
          contractVersion: discovery.data.contractVersion,
          region: discovery.data.region,
          requestId: discovery.meta.requestId,
          supportedCliMajor: compatibility.supportedMajor,
          version: discovery.data.version,
        },
        baseUrl,
        credentialSource,
        location,
        profile,
      },
      checks,
      apiExitCode(error),
    )
  }
}

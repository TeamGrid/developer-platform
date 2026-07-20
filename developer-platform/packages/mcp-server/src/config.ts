import {
  parseCredentialLocation,
  TeamGridClient,
  TeamGridClientError,
  type TeamGridClientOptions,
} from '@teamgrid/api-client'
import {
  ConfigStore,
  type CredentialStore,
  normalizeProfileName,
  SystemCredentialStore,
} from '@teamgrid/cli'
import { type McpToolProfile, parseMcpToolProfile } from './toolProfiles.js'

export type McpRuntimeDependencies = {
  configStore?: ConfigStore
  credentialStore?: CredentialStore
  environment?: NodeJS.ProcessEnv
}

export type McpArguments = {
  profile?: string
  toolProfile?: McpToolProfile
}

export function parseMcpArguments(argv: string[]): McpArguments {
  const result: McpArguments = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value || !['--profile', '--tool-profile'].includes(name || '')) {
      throw new TeamGridClientError(
        'invalid_arguments',
        "Expected only '--profile <name>' and '--tool-profile <profile>'.",
      )
    }
    if (name === '--profile') {
      if (result.profile) throw new TeamGridClientError('invalid_arguments', 'Duplicate profile.')
      result.profile = normalizeProfileName(value)
    } else {
      if (result.toolProfile) {
        throw new TeamGridClientError('invalid_arguments', 'Duplicate tool profile.')
      }
      try {
        result.toolProfile = parseMcpToolProfile(value)
      } catch (error) {
        throw new TeamGridClientError(
          'invalid_arguments',
          error instanceof Error ? error.message : 'Invalid MCP tool profile.',
        )
      }
    }
  }
  return result
}

export async function createMcpApiClient(
  argv = process.argv.slice(2),
  dependencies: McpRuntimeDependencies = {},
) {
  const environment = dependencies.environment || process.env
  const requestedProfile = parseMcpArguments(argv).profile
  const configStore = dependencies.configStore || new ConfigStore({ environment })
  const credentialStore = dependencies.credentialStore || new SystemCredentialStore()
  const config = await configStore.load()
  const profile = requestedProfile || config.currentProfile || 'default'
  const environmentToken = String(environment.TEAMGRID_API_TOKEN || '').trim()
  const token = environmentToken || (await credentialStore.get(profile))
  if (!token) {
    throw new TeamGridClientError(
      'authentication_required',
      `No credential found for profile '${profile}'. Run 'teamgrid auth login' first.`,
    )
  }
  const metadata = config.profiles[profile]
  const location = parseCredentialLocation(token)
  if (
    !environmentToken &&
    metadata &&
    (metadata.credentialId !== location.credentialId ||
      metadata.cellId !== location.cellId ||
      metadata.region !== location.region)
  ) {
    throw new TeamGridClientError(
      'profile_credential_mismatch',
      `The credential stored for profile '${profile}' does not match its metadata. Log in again.`,
    )
  }
  const baseUrl = String(
    environment.TEAMGRID_API_BASE_URL || (!environmentToken && metadata?.baseUrl) || '',
  ).trim()
  const options: TeamGridClientOptions = {
    ...(baseUrl ? { baseUrl } : {}),
    token,
  }
  return new TeamGridClient(options)
}

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

export type McpRuntimeDependencies = {
  configStore?: ConfigStore
  credentialStore?: CredentialStore
  environment?: NodeJS.ProcessEnv
}

function profileArgument(argv: string[]) {
  if (argv.length === 0) return undefined
  if (argv.length !== 2 || argv[0] !== '--profile' || !argv[1]) {
    throw new TeamGridClientError('invalid_arguments', "Expected only '--profile <name>'.")
  }
  return normalizeProfileName(argv[1])
}

export async function createMcpApiClient(
  argv = process.argv.slice(2),
  dependencies: McpRuntimeDependencies = {},
) {
  const environment = dependencies.environment || process.env
  const requestedProfile = profileArgument(argv)
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

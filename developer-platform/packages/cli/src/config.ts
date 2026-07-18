import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { TeamGridClientError } from '@teamgrid/api-client'

export type CliProfile = {
  baseUrl?: string
  cellId: string
  createdAt: string
  credentialId: string
  region: string
}

export type CliConfig = {
  currentProfile?: string
  profiles: Record<string, CliProfile>
  version: 1
}

export type ConfigStoreOptions = {
  configPath?: string
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function normalizeProfileName(value: string) {
  const name = String(value || '').trim()
  if (!profileNamePattern.test(name)) {
    throw new TeamGridClientError(
      'invalid_profile_name',
      'Profile names must use 1–64 letters, numbers, dots, underscores, or hyphens.',
    )
  }
  return name
}

export function defaultConfigPath(options: ConfigStoreOptions = {}) {
  if (options.configPath) return options.configPath
  const environment = options.environment || process.env
  if (environment.TEAMGRID_CONFIG_PATH) return environment.TEAMGRID_CONFIG_PATH
  const currentPlatform = options.platform || platform()
  const home = options.homeDirectory || homedir()
  if (currentPlatform === 'win32') {
    return join(environment.APPDATA || join(home, 'AppData', 'Roaming'), 'TeamGrid', 'config.json')
  }
  if (currentPlatform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'TeamGrid CLI', 'config.json')
  }
  return join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'teamgrid', 'config.json')
}

function emptyConfig(): CliConfig {
  return { profiles: {}, version: 1 }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseProfile(value: unknown): CliProfile | null {
  if (!isObject(value)) return null
  if (
    typeof value.cellId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.credentialId !== 'string' ||
    typeof value.region !== 'string' ||
    (value.baseUrl !== undefined && typeof value.baseUrl !== 'string')
  )
    return null
  return {
    ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
    cellId: value.cellId,
    createdAt: value.createdAt,
    credentialId: value.credentialId,
    region: value.region,
  }
}

function parseConfig(value: unknown): CliConfig {
  if (!isObject(value) || value.version !== 1 || !isObject(value.profiles)) {
    throw new TeamGridClientError('invalid_config', 'The TeamGrid CLI configuration is invalid.')
  }
  const profiles: Record<string, CliProfile> = {}
  for (const [name, profileValue] of Object.entries(value.profiles)) {
    const profile = parseProfile(profileValue)
    if (!profile || !profileNamePattern.test(name)) {
      throw new TeamGridClientError('invalid_config', 'The TeamGrid CLI configuration is invalid.')
    }
    profiles[name] = profile
  }
  const currentProfile =
    typeof value.currentProfile === 'string'
      ? normalizeProfileName(value.currentProfile)
      : undefined
  if (currentProfile && !profiles[currentProfile]) {
    throw new TeamGridClientError(
      'invalid_config',
      'The current TeamGrid CLI profile does not exist.',
    )
  }
  return { ...(currentProfile ? { currentProfile } : {}), profiles, version: 1 }
}

async function assertNotSymlink(path: string) {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new TeamGridClientError(
        'unsafe_config_path',
        'The TeamGrid CLI config path must be a regular file, not a symbolic link.',
      )
    }
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return
    throw error
  }
}

export class ConfigStore {
  readonly path: string

  constructor(options: ConfigStoreOptions = {}) {
    this.path = defaultConfigPath(options)
  }

  async load(): Promise<CliConfig> {
    await assertNotSymlink(this.path)
    try {
      const source = await readFile(this.path, 'utf8')
      return parseConfig(JSON.parse(source) as unknown)
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return emptyConfig()
      if (error instanceof TeamGridClientError) throw error
      throw new TeamGridClientError('invalid_config', 'Could not read the TeamGrid CLI config.', {
        cause: error,
      })
    }
  }

  async save(config: CliConfig) {
    const validated = parseConfig(config)
    const directory = dirname(this.path)
    const createdDirectory = await mkdir(directory, { mode: 0o700, recursive: true })
    if (createdDirectory !== undefined) await chmod(directory, 0o700)
    await assertNotSymlink(this.path)
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    try {
      await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async exists() {
    try {
      await access(this.path)
      return true
    } catch {
      return false
    }
  }
}

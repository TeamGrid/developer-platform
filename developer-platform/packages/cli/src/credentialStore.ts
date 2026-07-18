import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { TeamGridClientError } from '@teamgrid/api-client'

export type CredentialCommandResult = {
  stderr: string
  stdout: string
}

export type CredentialCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<CredentialCommandResult>

export interface CredentialStore {
  delete(profile: string): Promise<void>
  get(profile: string): Promise<string | null>
  set(profile: string, token: string): Promise<void>
}

const serviceName = 'teamgrid-cli'
const maxOutputBytes = 16 * 1024

export function runCredentialCommand(command: string, args: string[], input?: string) {
  return new Promise<CredentialCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxOutputBytes) stdout += chunk.slice(0, maxOutputBytes - stdout.length)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxOutputBytes) stderr += chunk.slice(0, maxOutputBytes - stderr.length)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr, stdout })
      else {
        const error = new Error(`Credential helper exited with status ${code ?? 'unknown'}.`)
        Object.assign(error, { code, stderr })
        reject(error)
      }
    })
    if (input !== undefined) child.stdin.end(`${input}\n`)
    else child.stdin.end()
  })
}

function isMissingCredential(error: unknown) {
  return error instanceof Error && /status (?:44|1)\b/.test(error.message)
}

function credentialStoreUnavailable(error: unknown): never {
  throw new TeamGridClientError(
    'credential_store_unavailable',
    'No supported OS credential store is available. Use TEAMGRID_API_TOKEN for this session.',
    { cause: error },
  )
}

export class SystemCredentialStore implements CredentialStore {
  readonly #platform: NodeJS.Platform
  readonly #run: CredentialCommandRunner

  constructor({
    currentPlatform = platform(),
    run = runCredentialCommand,
  }: {
    currentPlatform?: NodeJS.Platform
    run?: CredentialCommandRunner
  } = {}) {
    this.#platform = currentPlatform
    this.#run = run
  }

  async get(profile: string) {
    try {
      if (this.#platform === 'darwin') {
        const result = await this.#run('security', [
          'find-generic-password',
          '-s',
          serviceName,
          '-a',
          profile,
          '-w',
        ])
        return result.stdout.trim() || null
      }
      if (this.#platform === 'linux') {
        const result = await this.#run('secret-tool', [
          'lookup',
          'service',
          serviceName,
          'profile',
          profile,
        ])
        return result.stdout.trim() || null
      }
      return credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      if (isMissingCredential(error)) return null
      return credentialStoreUnavailable(error)
    }
  }

  async set(profile: string, token: string) {
    try {
      if (this.#platform === 'darwin') {
        await this.#run(
          'security',
          ['add-generic-password', '-U', '-s', serviceName, '-a', profile, '-w'],
          token,
        )
        return
      }
      if (this.#platform === 'linux') {
        await this.#run(
          'secret-tool',
          ['store', '--label=TeamGrid CLI', 'service', serviceName, 'profile', profile],
          token,
        )
        return
      }
      credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      credentialStoreUnavailable(error)
    }
  }

  async delete(profile: string) {
    try {
      if (this.#platform === 'darwin') {
        await this.#run('security', ['delete-generic-password', '-s', serviceName, '-a', profile])
        return
      }
      if (this.#platform === 'linux') {
        await this.#run('secret-tool', ['clear', 'service', serviceName, 'profile', profile])
        return
      }
      credentialStoreUnavailable(new Error(`Unsupported platform ${this.#platform}.`))
    } catch (error) {
      if (isMissingCredential(error)) return
      credentialStoreUnavailable(error)
    }
  }
}

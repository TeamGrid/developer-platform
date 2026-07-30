import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function parseArguments(arguments_) {
  const [action, ...options] = arguments_
  if (!['delete', 'status', 'store'].includes(action)) {
    throw new Error('Expected credential action store, status, or delete.')
  }
  let profile
  let version
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '--profile') profile = options[++index]
    else if (options[index] === '--version') version = options[++index]
    else throw new Error(`Unknown credential argument: ${options[index]}`)
  }
  if (!['v0', 'v1'].includes(version)) throw new Error('--version must be v0 or v1.')
  if (!profilePattern.test(profile || '')) throw new Error('--profile is malformed.')
  return { action, profile, version }
}

function validateCredential(token, version, parseV1Credential) {
  if (token.length < 16 || token.length > 512 || /\s/.test(token)) {
    throw new Error('The credential has an invalid shape.')
  }
  let recognizedAsV1 = false
  try {
    parseV1Credential(token)
    recognizedAsV1 = true
  } catch {
    recognizedAsV1 = false
  }
  if (version === 'v1' && !recognizedAsV1) {
    throw new Error('The credential is not a TeamGrid V1 credential.')
  }
  if (version === 'v0' && recognizedAsV1) {
    throw new Error('A V1 credential cannot be stored as a legacy V0 credential.')
  }
}

function runNativeMacKeychainPrompt(profile) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'security',
      ['add-generic-password', '-U', '-s', 'teamgrid-cli', '-a', profile, '-w'],
      {
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else
        rejectPromise(new Error(`macOS Keychain helper exited with status ${code ?? 'unknown'}.`))
    })
  })
}

async function loadDefaultDependencies() {
  const [{ password }, { parseCredentialLocation }, { SystemCredentialStore }] = await Promise.all([
    import('@inquirer/prompts'),
    import('../../packages/api-client/dist/index.js'),
    import('../../packages/cli/dist/index.js'),
  ])
  const credentialStore = new SystemCredentialStore()
  return {
    credentialStore,
    parseV1Credential: parseCredentialLocation,
    ...(platform() === 'darwin'
      ? {
          promptAndStore: async (profile) => {
            process.stdout.write(
              `Paste the credential at the native macOS Keychain prompt for '${profile}'.\n`,
            )
            await runNativeMacKeychainPrompt(profile)
            return credentialStore.get(profile)
          },
        }
      : {}),
    promptSecret: (message) => password({ mask: '•', message }),
  }
}

export async function runCredentialCommand({
  arguments_: argumentsValue = process.argv.slice(2),
  dependenciesLoader = loadDefaultDependencies,
} = {}) {
  const options = parseArguments(argumentsValue)
  const dependencies = await dependenciesLoader()

  if (options.action === 'delete') {
    await dependencies.credentialStore.delete(options.profile)
    return { profile: options.profile, stored: false, version: options.version }
  }
  if (options.action === 'status') {
    const token = await dependencies.credentialStore.get(options.profile)
    return { profile: options.profile, stored: Boolean(token), version: options.version }
  }

  const storedByNativePrompt = typeof dependencies.promptAndStore === 'function'
  const token = String(
    storedByNativePrompt
      ? await dependencies.promptAndStore(options.profile)
      : await dependencies.promptSecret(
          `Paste the TeamGrid ${options.version.toUpperCase()} credential for '${options.profile}'`,
        ),
  ).trim()
  try {
    validateCredential(token, options.version, dependencies.parseV1Credential)
  } catch (error) {
    if (storedByNativePrompt) await dependencies.credentialStore.delete(options.profile)
    throw error
  }
  if (!storedByNativePrompt) await dependencies.credentialStore.set(options.profile, token)
  return { profile: options.profile, stored: true, version: options.version }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  process.stdout.write(`${JSON.stringify(await runCredentialCommand(), null, 2)}\n`)
}

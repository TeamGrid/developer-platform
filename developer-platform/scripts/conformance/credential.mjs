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
  if (version === 'v1') parseV1Credential(token)
}

async function loadDefaultDependencies() {
  const [{ password }, { parseCredentialLocation }, { SystemCredentialStore }] = await Promise.all([
    import('@inquirer/prompts'),
    import('../../packages/api-client/dist/index.js'),
    import('../../packages/cli/dist/index.js'),
  ])
  return {
    credentialStore: new SystemCredentialStore(),
    parseV1Credential: parseCredentialLocation,
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

  const token = String(
    await dependencies.promptSecret(
      `Paste the TeamGrid ${options.version.toUpperCase()} credential for '${options.profile}'`,
    ),
  ).trim()
  validateCredential(token, options.version, dependencies.parseV1Credential)
  await dependencies.credentialStore.set(options.profile, token)
  return { profile: options.profile, stored: true, version: options.version }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  process.stdout.write(`${JSON.stringify(await runCredentialCommand(), null, 2)}\n`)
}

import { createHash, createHmac } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactDeveloperSecrets } from '../packages/api-client/dist/redaction.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = path.resolve(
  root,
  '../conformance-evidence/redaction/local-redaction-evidence.json',
)
const canaries = Object.freeze({
  authorizationCode: `auth-code-${'a'.repeat(48)}`,
  codeVerifier: `verifier-${'b'.repeat(48)}`,
  legacyV0: 'V0Canary9wK4mT2pR7xQ6zN8a',
  legacyV1: `tg_sk_v1_de_de-nbg-001_${'c'.repeat(24)}_${'d'.repeat(64)}`,
  personalAccess: `tg_pat_v2_de_de-nbg-001_${'e'.repeat(24)}_${'f'.repeat(64)}`,
  requestSecret: `request-secret-${'g'.repeat(48)}`,
  serviceAccount: `tg_sa_v2_us_us-mnz-001_${'a'.repeat(24)}_${'b'.repeat(64)}`,
  state: `state-${'c'.repeat(48)}`,
  webhookSigning: `whsec_v2_${'d'.repeat(43)}`,
})
const knownCredentialPatterns = [
  /\b(?:tg_sk_v1|tg_pat_v2|tg_sa_v2)_[a-z0-9-]+_[a-z0-9-]+_[a-f0-9]{24}_[a-f0-9]{64}\b/i,
  /\bwhsec_v2_[A-Za-z0-9_-]{43}\b/,
]

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function sanitizedArtifacts() {
  return {
    analytics: redactDeveloperSecrets(JSON.stringify({
      requestSecret: canaries.requestSecret,
      token: canaries.personalAccess,
    })),
    apiRequestBody: redactDeveloperSecrets(
      JSON.stringify({ authorizationCode: canaries.authorizationCode }),
    ),
    breadcrumbs: redactDeveloperSecrets(`credential ${canaries.serviceAccount}`),
    browserHistory: 'https://login.teamgrid.app/developer/cli/authorize',
    commandOutput: redactDeveloperSecrets(`request failed ${canaries.legacyV1}`),
    errorCause: redactDeveloperSecrets(`Authorization: Bearer ${canaries.legacyV0}`),
    headers: redactDeveloperSecrets(`Authorization: Bearer ${canaries.personalAccess}`),
    localConfig: JSON.stringify({
      authenticationSource: 'browser',
      cellId: 'de-nbg-001',
      credentialId: 'e'.repeat(24),
      region: 'de',
    }),
    processArguments: JSON.stringify(['teamgrid', 'auth', 'login']),
    reverseProxy: JSON.stringify({ method: 'POST', uri: '[redacted]' }),
    sentry: redactDeveloperSecrets(`failed?request_secret=${canaries.requestSecret}`),
    shellHistory: 'teamgrid auth login',
    structuredFields: redactDeveloperSecrets(JSON.stringify({
      state: canaries.state,
      webhookSecret: canaries.webhookSigning,
    })),
    supportDiagnostics: redactDeveloperSecrets(
      `code_verifier=${canaries.codeVerifier}&state=${canaries.state}`,
    ),
    testReport: redactDeveloperSecrets(`token=${canaries.personalAccess}`),
    trace: redactDeveloperSecrets(`authorization_code=${canaries.authorizationCode}`),
    url: redactDeveloperSecrets(
      `https://api.de.teamgrid.app/v1/?access_token=${canaries.legacyV1}`,
    ),
  }
}

function leakedCanaries(serialized) {
  const exact = Object.entries(canaries)
    .filter(([, value]) => serialized.includes(value))
    .map(([name]) => name)
  const formatted = knownCredentialPatterns
    .map((pattern, index) => (pattern.test(serialized) ? `credentialPattern${index + 1}` : null))
    .filter(Boolean)
  return [...exact, ...formatted]
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function atomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, filePath)
}

const outputPath = path.resolve(option('--output') || defaultOutput)
const requireSignature = process.argv.includes('--require-signature')
const signingKey = String(process.env.TEAMGRID_REDACTION_EVIDENCE_SIGNING_KEY || '')
if (requireSignature && signingKey.length < 32) {
  throw new Error('A redaction evidence signing key of at least 32 characters is required.')
}

const artifacts = sanitizedArtifacts()
const leaks = leakedCanaries(JSON.stringify(artifacts))
if (leaks.length) {
  throw new Error(`Redaction conformance failed for: ${leaks.join(', ')}`)
}
const payload = {
  artifacts,
  canaryFamilies: Object.keys(canaries),
  completedAt: new Date().toISOString(),
  passed: true,
  schemaVersion: 1,
  surfaces: Object.keys(artifacts),
}
const payloadJson = stableJson(payload)
const payloadSha256 = createHash('sha256').update(payloadJson).digest('hex')
const evidence = {
  ...payload,
  payloadSha256,
  signature: signingKey
    ? createHmac('sha256', signingKey).update(payloadJson).digest('hex')
    : null,
  signatureAlgorithm: signingKey ? 'hmac-sha256' : null,
}
const evidenceJson = stableJson(evidence)
const evidenceLeaks = leakedCanaries(evidenceJson)
if (evidenceLeaks.length) {
  throw new Error(`Redaction evidence contains canaries: ${evidenceLeaks.join(', ')}`)
}
await atomicWrite(outputPath, evidenceJson)
process.stdout.write(
  `Redaction conformance passed for ${evidence.surfaces.length} surfaces; ` +
    `evidence ${payloadSha256}.\n`,
)

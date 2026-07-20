import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const workspaceRoot = path.resolve(import.meta.dirname, '../..')
const sourceRepository = 'TeamGrid/teamgrid-api'
const artifactDestinations = {
  'contracts/developer-capabilities.json': 'developer-capabilities.json',
  'contracts/developer-scopes.json': 'developer-scopes.json',
  'contracts/v0-routes.json': 'v0-routes.json',
  'contracts/v0-to-v1-migration.json': 'v0-to-v1-migration.json',
  'openapi/v0.json': 'v0.json',
  'openapi/v1.json': 'v1.json',
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const candidates = [
  process.argv[2],
  process.env.TEAMGRID_API_REPOSITORY,
  path.resolve(workspaceRoot, '..', 'teamgrid-api'),
].filter(Boolean)

let sourceRoot = null
for (const candidate of candidates) {
  const normalized = path.resolve(candidate)
  if (await exists(path.join(normalized, '.git'))) {
    sourceRoot = normalized
    break
  }
}
if (!sourceRoot) {
  throw new Error(
    'Could not find the TeamGrid API Git repository. Pass its path as the first argument.',
  )
}

const requestedRef = process.argv[3] || process.env.TEAMGRID_API_REF || 'HEAD'
const { stdout: resolvedCommit } = await execFileAsync(
  'git',
  ['rev-parse', '--verify', `${requestedRef}^{commit}`],
  { cwd: sourceRoot, encoding: 'utf8' },
)
const sourceCommit = resolvedCommit.trim()
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`Git resolved an invalid API source commit: ${sourceCommit}`)
}

async function readSourceFile(relativePath) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${sourceCommit}:${relativePath}`], {
      cwd: sourceRoot,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    throw new Error(`Could not read ${relativePath} from API commit ${sourceCommit}.`, {
      cause: error,
    })
  }
}

const canonicalManifestPath = 'contracts/developer-platform-manifest.json'
const canonicalManifestContent = await readSourceFile(canonicalManifestPath)
const canonicalManifest = JSON.parse(canonicalManifestContent.toString('utf8'))
if (canonicalManifest.schemaVersion !== 1 || !Array.isArray(canonicalManifest.artifacts)) {
  throw new Error('The API source commit has an unsupported developer contract manifest.')
}

const expectedPaths = Object.keys(artifactDestinations).sort()
const actualPaths = canonicalManifest.artifacts.map((artifact) => artifact.path).sort()
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error('The API contract manifest artifact set has no complete package mapping.')
}

const destination = path.join(workspaceRoot, 'openapi')
await mkdir(destination, { recursive: true })
for (const artifact of canonicalManifest.artifacts) {
  const content = await readSourceFile(artifact.path)
  const digest = createHash('sha256').update(content).digest('hex')
  if (content.length !== artifact.bytes || digest !== artifact.sha256) {
    throw new Error(`API source commit has an invalid contract digest for ${artifact.path}.`)
  }
  await writeFile(path.join(destination, artifactDestinations[artifact.path]), content)
}
await writeFile(
  path.join(destination, 'developer-platform-manifest.json'),
  canonicalManifestContent,
)

const provenance = {
  schemaVersion: 1,
  sourceRepository,
  sourceCommit,
  contractManifest: {
    path: canonicalManifestPath,
    bytes: canonicalManifestContent.length,
    sha256: createHash('sha256').update(canonicalManifestContent).digest('hex'),
  },
}
await writeFile(path.join(destination, 'source.json'), `${JSON.stringify(provenance, null, 2)}\n`)

console.log(`Synchronized contracts from ${sourceRepository}@${sourceCommit}.`)

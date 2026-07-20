import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const manifestUrl = new URL('../../openapi/developer-platform-manifest.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const manifestContent = await readFile(manifestUrl)
const provenance = JSON.parse(
  await readFile(new URL('../../openapi/source.json', import.meta.url), 'utf8'),
)
const localArtifacts = {
  'contracts/developer-capabilities.json': '../../openapi/developer-capabilities.json',
  'contracts/developer-operation-bindings.json': '../../openapi/developer-operation-bindings.json',
  'contracts/developer-scopes.json': '../../openapi/developer-scopes.json',
  'contracts/v0-routes.json': '../../openapi/v0-routes.json',
  'contracts/v0-to-v1-migration.json': '../../openapi/v0-to-v1-migration.json',
  'openapi/v0.json': '../../openapi/v0.json',
  'openapi/v1.json': '../../openapi/v1.json',
}

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
  throw new Error('Developer platform contract manifest has an unsupported shape')
}

const expectedPaths = Object.keys(localArtifacts).sort()
const actualPaths = manifest.artifacts.map((artifact) => artifact.path).sort()
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error('Developer platform contract manifest has an incomplete local mapping')
}

const manifestDigest = createHash('sha256').update(manifestContent).digest('hex')
if (
  provenance.schemaVersion !== 1 ||
  provenance.sourceRepository !== 'TeamGrid/teamgrid-api' ||
  !/^[0-9a-f]{40}$/.test(provenance.sourceCommit || '') ||
  provenance.contractManifest?.path !== 'contracts/developer-platform-manifest.json' ||
  provenance.contractManifest?.bytes !== manifestContent.length ||
  provenance.contractManifest?.sha256 !== manifestDigest
) {
  throw new Error('Developer platform contract source provenance is invalid')
}

for (const artifact of manifest.artifacts) {
  const localPath = localArtifacts[artifact.path]
  if (!localPath) throw new Error(`Contract artifact has no local mapping: ${artifact.path}`)
  const content = await readFile(new URL(localPath, import.meta.url))
  const digest = createHash('sha256').update(content).digest('hex')
  if (content.length !== artifact.bytes || digest !== artifact.sha256) {
    throw new Error(`Contract artifact drift detected: ${artifact.path}`)
  }
}

console.log(
  `Contract manifest ${manifest.contractVersion} from ${provenance.sourceCommit} verified (${manifest.artifacts.length} artifacts)`,
)

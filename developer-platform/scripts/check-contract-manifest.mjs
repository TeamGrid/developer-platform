import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const manifestUrl = new URL('../../openapi/developer-platform-manifest.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const localArtifacts = {
  'contracts/developer-capabilities.json': '../../openapi/developer-capabilities.json',
  'contracts/v0-routes.json': '../../openapi/v0-routes.json',
  'openapi/v0.json': '../../openapi/v0.json',
  'openapi/v1.json': '../../openapi/v1.json',
}

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
  throw new Error('Developer platform contract manifest has an unsupported shape')
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
  `Contract manifest ${manifest.contractVersion} verified (${manifest.artifacts.length} artifacts)`,
)

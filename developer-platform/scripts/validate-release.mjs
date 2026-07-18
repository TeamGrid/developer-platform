import { readFile } from 'node:fs/promises'

const packageDirectories = ['api-client', 'cli', 'mcp-server']
const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex === -1 ? undefined : process.argv[modeIndex + 1]
const expectedVersion = process.env.RELEASE_VERSION
const distTag = process.env.RELEASE_DIST_TAG

function fail(message) {
  throw new Error(`Release validation failed: ${message}`)
}

if (mode !== 'stage') fail('mode must be stage')
if (!expectedVersion) fail('RELEASE_VERSION is required')
if (!['next', 'latest'].includes(distTag)) fail('RELEASE_DIST_TAG must be next or latest')

const manifests = await Promise.all(
  packageDirectories.map(async (directory) => {
    const contents = await readFile(
      new URL(`../packages/${directory}/package.json`, import.meta.url),
    )
    return JSON.parse(contents)
  }),
)

for (const manifest of manifests) {
  if (manifest.version !== expectedVersion) {
    fail(`${manifest.name} is ${manifest.version}, expected ${expectedVersion}`)
  }
  if (manifest.license !== 'MIT') fail(`${manifest.name} is not MIT licensed`)
  if (manifest.publishConfig?.access !== 'public') fail(`${manifest.name} is not public`)
  if (manifest.publishConfig?.provenance !== true)
    fail(`${manifest.name} does not require provenance`)
  if (manifest.repository?.url !== 'git+https://github.com/TeamGrid/developer-platform.git') {
    fail(`${manifest.name} repository metadata does not match the trusted publisher`)
  }
}

const isPrerelease = expectedVersion.includes('-')
if (isPrerelease && distTag !== 'next') fail('prereleases must use the next dist-tag')
if (!isPrerelease && distTag !== 'latest') fail('stable releases must use the latest dist-tag')

if (process.env.GITHUB_ACTIONS === 'true') {
  if (process.env.GITHUB_REPOSITORY !== 'TeamGrid/developer-platform') {
    fail('workflow is not running in the canonical repository')
  }
  if (process.env.GITHUB_REF_TYPE !== 'tag') fail('workflow must run from a Git tag')
  if (process.env.GITHUB_REF_NAME !== `v${expectedVersion}`) {
    fail(`Git tag must be v${expectedVersion}`)
  }
}

async function packageStatus(name, version) {
  const encodedName = name.replace('/', '%2f')
  const response = await fetch(`https://registry.npmjs.org/${encodedName}/${version}`)
  if (response.status === 404) return 'missing'
  if (!response.ok) fail(`registry lookup for ${name}@${version} returned ${response.status}`)
  return 'published'
}

for (const manifest of manifests) {
  const exactVersionStatus = await packageStatus(manifest.name, expectedVersion)
  if (exactVersionStatus !== 'missing') fail(`${manifest.name}@${expectedVersion} already exists`)

  const packageResponse = await fetch(
    `https://registry.npmjs.org/${manifest.name.replace('/', '%2f')}`,
    { method: 'HEAD' },
  )
  if (![200, 404].includes(packageResponse.status)) {
    fail(`registry lookup for ${manifest.name} returned ${packageResponse.status}`)
  }
  if (packageResponse.status !== 200) {
    fail(`${manifest.name} does not exist yet and cannot use staged publishing`)
  }
}

console.log(`Validated ${mode} release v${expectedVersion} with dist-tag ${distTag}`)

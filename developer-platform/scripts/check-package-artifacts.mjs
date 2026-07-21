import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryUrl = 'git+https://github.com/TeamGrid/developer-platform.git'
const packages = [
  { name: '@teamgrid/api-client', requiredFiles: ['dist/index.d.ts', 'dist/index.js'] },
  { name: '@teamgrid/cli', requiredFiles: ['dist/bin.js', 'dist/index.d.ts', 'dist/index.js'] },
  { name: '@teamgrid/mcp-server', requiredFiles: ['dist/bin.js', 'dist/index.d.ts', 'dist/index.js'] },
]

function fail(message) {
  throw new Error(`Package artifact gate failed: ${message}`)
}

const manifests = packages.map((entry) => {
  const directory = resolve('packages', entry.name.split('/')[1])
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  if (manifest.name !== entry.name) fail(`${entry.name} manifest name differs`)
  if (manifest.license !== 'MIT') fail(`${entry.name} must use the approved MIT license`)
  if (manifest.repository?.url !== repositoryUrl) fail(`${entry.name} repository is not canonical`)
  if (manifest.publishConfig?.access !== 'public') fail(`${entry.name} must publish as public`)
  if (manifest.publishConfig?.provenance !== true) fail(`${entry.name} must require provenance`)
  if (manifest.engines?.node !== '>=22.14 <25') {
    fail(`${entry.name} must support the tested Node.js 22.14 through 24 range`)
  }
  if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    fail(`${entry.name} registry is not canonical`)
  }
  return { ...entry, manifest }
})

const versions = new Set(manifests.map(({ manifest }) => manifest.version))
if (versions.size !== 1) fail('all public packages must use one release version')
const [version] = versions
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('release version is invalid')
const contractManifest = JSON.parse(
  readFileSync(resolve('..', 'openapi', 'developer-platform-manifest.json'), 'utf8'),
)
if (contractManifest.contractVersion !== version) {
  fail('all public package versions must equal the canonical contract version')
}

for (const { manifest, name, requiredFiles } of manifests) {
  for (const dependencyName of ['@teamgrid/api-client', '@teamgrid/cli']) {
    const dependencyVersion = manifest.dependencies?.[dependencyName]
    if (dependencyVersion && dependencyVersion !== version) {
      fail(`${name} must pin ${dependencyName} to the release version`)
    }
  }

  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--workspace', name],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  )
  if (result.status !== 0) fail(`${name} npm pack failed: ${result.stderr.trim()}`)
  const [artifact] = JSON.parse(result.stdout)
  if (!artifact || artifact.id !== `${name}@${version}`) fail(`${name} produced an unexpected package id`)
  const files = artifact.files.map(file => file.path).sort()
  const unexpected = files.filter(
    path => !['LICENSE', 'README.md', 'package.json'].includes(path) && !path.startsWith('dist/'),
  )
  if (unexpected.length) fail(`${name} contains unexpected files: ${unexpected.join(', ')}`)
  for (const requiredFile of ['LICENSE', 'README.md', 'package.json', ...requiredFiles]) {
    if (!files.includes(requiredFile)) fail(`${name} is missing ${requiredFile}`)
  }
  if (files.some(path => path.endsWith('.map'))) fail(`${name} contains unpublished source maps`)
  if (artifact.unpackedSize > 1_500_000) fail(`${name} exceeds the 1.5 MB unpacked limit`)
  console.log(`${artifact.id}: ${files.length} files, ${artifact.unpackedSize} bytes`)
}

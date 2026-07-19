import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(
  await readFile(new URL('../packages/api-client/package.json', import.meta.url), 'utf8'),
)
const versionSource = await readFile(
  new URL('../packages/api-client/src/version.ts', import.meta.url),
  'utf8',
)
const match = versionSource.match(/apiClientVersion = '([^']+)'/)
if (!match || match[1] !== packageJson.version) {
  throw new Error('api-client version header must match packages/api-client/package.json')
}
console.log(`API client version header is current: ${packageJson.version}`)

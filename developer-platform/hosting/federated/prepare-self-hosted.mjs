import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPrivateJson } from './config.mjs'
import { createSelfHostedArtifacts } from './selfHosting.mjs'

export function prepareSelfHosted(environment, output) {
  if (!isAbsolute(output)) throw new Error('Absolute output directory required.')
  const config = readPrivateJson(environment.TEAMGRID_FEDERATION_CONFIG_FILE)
  // Initial operating artifacts remain closed until qualification and release admission.
  if (config.enabled !== false || config.writesEnabled !== false)
    throw new Error('Initial self-hosted configuration must be disabled.')
  const specification = readPrivateJson(environment.TEAMGRID_FEDERATION_DEPLOYMENT_FILE)
  const artifacts = createSelfHostedArtifacts(config, specification)
  mkdirSync(output, { mode: 0o700 }) // Refuse an existing directory; never replace an operator file.
  const files = {
    'compose.json': JSON.stringify(artifacts.compose, null, 2),
    'Caddyfile.site': artifacts.caddySite,
    'caddy-network.review.json': JSON.stringify(artifacts.caddyNetwork, null, 2),
  }
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(output, name), `${content}\n`, { mode: 0o600, flag: 'wx' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    prepareSelfHosted(process.env, process.argv[2] ?? '')
    process.stdout.write('Self-hosted operating artifacts prepared; no deployment performed.\n')
  } catch {
    process.stderr.write(
      'Self-hosted preparation failed; check private inputs and output directory.\n',
    )
    process.exitCode = 1
  }
}

import { readPrivateJson } from './config.mjs'
import { createFederatedService } from './service.mjs'

async function main() {
  const file = process.env.TEAMGRID_FEDERATION_CONFIG_FILE
  if (!file) throw new Error('Missing service configuration.')
  const service = await createFederatedService({
    readConfig: () => readPrivateJson(file),
  })
  try {
    await service.listen()
  } catch {
    await service.close()
    throw new Error('Service listen failed.')
  }
  process.stderr.write('teamgrid-federated-mcp: listening\n')
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      if (stopping) return
      stopping = true
      void service.close().catch(() => {
        process.exitCode = 1
      })
    })
}

main().catch(() => {
  // No paths, connection strings, credentials, URLs or raw dependency errors.
  process.stderr.write('teamgrid-federated-mcp: startup failed; check private configuration.\n')
  process.exitCode = 1
})

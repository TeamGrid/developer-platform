import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDirectory = path.resolve(root, '../conformance-evidence/browser-auth')
const npmCli = process.env.npm_execpath
const packages = ['@teamgrid/api-client', '@teamgrid/cli', '@teamgrid/mcp-server']

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    const detail = capture
      ? String(result.stderr || result.stdout || result.error?.message || '').trim()
      : String(result.error?.message || '').trim()
    throw new Error(
      `Packed install check failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`,
    )
  }
  return String(result.stdout || '')
}

function runNpm(args, cwd, capture = false) {
  if (!npmCli) {
    throw new Error(
      'Packed install check requires npm_execpath. Run it through npm run pack:install-check.',
    )
  }
  return run(process.execPath, [npmCli, ...args], cwd, capture)
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'teamgrid-packed-install-'))
try {
  const tarballDirectory = path.join(temporaryRoot, 'tarballs')
  const installDirectory = path.join(temporaryRoot, 'install')
  await mkdir(tarballDirectory)
  await mkdir(installDirectory)
  await writeFile(
    path.join(installDirectory, 'package.json'),
    `${JSON.stringify({ name: 'teamgrid-packed-install-check', private: true }, null, 2)}\n`,
  )

  const artifactIds = []
  const artifactIntegrities = {}
  const tarballs = packages.map((packageName) => {
    const packed = JSON.parse(
      runNpm(
        ['pack', '--json', '--workspace', packageName, '--pack-destination', tarballDirectory],
        root,
        true,
      ),
    )
    const artifact = packed[0]
    if (
      !artifact?.filename
      || typeof artifact.id !== 'string'
      || !artifact.id.startsWith(`${packageName}@`)
    ) {
      throw new Error(`Packed install check produced an unexpected artifact for ${packageName}.`)
    }
    artifactIds.push(artifact.id)
    artifactIntegrities[packageName] = artifact.integrity
    return path.join(tarballDirectory, artifact.filename)
  })

  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs],
    installDirectory,
  )
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "await import('@teamgrid/api-client'); await import('@teamgrid/cli'); await import('@teamgrid/mcp-server')",
    ],
    installDirectory,
  )
  run(
    process.execPath,
    [path.join(installDirectory, 'node_modules/@teamgrid/cli/dist/bin.js'), '--help'],
    installDirectory,
    true,
  )
  run(
    process.execPath,
    [path.join(installDirectory, 'node_modules/@teamgrid/mcp-server/dist/bin.js'), '--help'],
    installDirectory,
    true,
  )

  // Exercise the installed binary, including modern opt-in and legacy fallback.
  // This synthetic credential is never sent to an API: discovery is local only.
  const syntheticToken = // gitleaks:allow -- non-secret packed-install routing fixture
    `tg_pat_v2_de_de-nbg-001_${'a'.repeat(24)}_${'b'.repeat(64)}`
  const mcpProtocols = []
  for (const era of ['modern', 'legacy']) {
    for (const [profile, count] of [['core', 22], ['work', 41]]) {
      const client = new Client({ name: 'packed-install', version: '1.0.0' }, {
        versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
      })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(installDirectory, 'node_modules/@teamgrid/mcp-server/dist/bin.js'), '--tool-profile', profile],
        cwd: installDirectory,
        env: { TEAMGRID_API_TOKEN: syntheticToken, TEAMGRID_CONFIG_PATH: path.join(installDirectory, 'unused-config.json') },
        stderr: 'pipe',
      })
      try {
        await client.connect(transport)
        const { tools } = await client.listTools()
        if (client.getProtocolEra() !== era || tools.length !== count || (profile === 'core' && tools.some((tool) => tool.annotations?.readOnlyHint !== true))) {
          throw new Error(`Packed MCP discovery differs for ${era}/${profile}.`)
        }
        mcpProtocols.push({ era, profile, tools: tools.length })
      } finally {
        await client.close()
      }
    }
  }

  const evidence = {
    completedAt: new Date().toISOString(),
    nodeVersion: process.version,
    packages: artifactIds,
    artifactIntegrities,
    mcpProtocols,
    passed: true,
    platform: process.platform,
    schemaVersion: 1,
    tests: ['cleanInstall', 'packageImports', 'cliBinary', 'mcpBinary', 'mcpModernAndLegacyDiscovery'],
  }
  await mkdir(evidenceDirectory, { recursive: true })
  const evidencePath = path.join(
    evidenceDirectory,
    `packed-install-${process.platform}-${process.version.replace(/[^0-9.]/g, '')}.json`,
  )
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(
    `Packed install check passed on ${process.platform} ${process.version} for ${packages.join(', ')}.`,
  )
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}

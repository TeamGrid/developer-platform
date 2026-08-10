import { readFileSync } from 'node:fs'

const nativeProcess = globalThis.process
const compiledClient = readFileSync(
  new URL('../packages/api-client/dist/client.js', import.meta.url),
  'utf8',
)
if (/from ['"]node:|\bBuffer\b|\bprocess\./.test(compiledClient)) {
  throw new Error('The compiled API client contains a Node-only runtime dependency.')
}
globalThis.process = undefined

try {
  const { TeamGridClient } = await import('../packages/api-client/dist/index.js')
  const token = // gitleaks:allow -- synthetic fixed-format qualification credential
    'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_'
    + '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const client = new TeamGridClient({
    fetch: async () => new Response(JSON.stringify({
      data: {
        attributes: {
          cellId: 'us-mnz-001',
          currency: 'USD',
          language: 'en',
          name: 'Edge qualification',
          region: 'us',
          timeZone: 'UTC',
        },
        id: 'workspace-1',
        type: 'workspace',
      },
      meta: { requestId: 'edge-runtime-request' },
    }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'edge-runtime-request' },
    }),
    token,
  })
  const workspace = await client.workspace.get()
  if (workspace.data.id !== 'workspace-1' || workspace.transport.status !== 200) {
    throw new Error('The API client did not preserve its response contract in an edge runtime.')
  }
  nativeProcess.stdout.write('API client edge-runtime qualification passed.\n')
} finally {
  globalThis.process = nativeProcess
}

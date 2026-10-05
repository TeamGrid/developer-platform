import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import AjvDraft4 from 'ajv-draft-04'
import addFormats from 'ajv-formats'
import { createTeamGridMcpHttpHandler } from '../packages/mcp-server/dist/index.js'

const repository = new URL('../../', import.meta.url)
const checking = process.argv.includes('--check')
if (process.argv.slice(2).some((arg) => arg !== '--check'))
  throw new Error('This builder creates draft packages only. Supported option: --check.')

const read = (path) => readFile(new URL(path, repository))
const json = async (path) => JSON.parse(await read(path))
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const config = await json('integrations/config.json')
const publisher = config.publisher?.legalName
const publisherDisplayName = config.publisher?.displayName
const publisherIdentityNotice = {
  'owner-confirmed-vendor-verification-pending':
    'Publisher identity verification in the vendor directories remains pending.',
  'openai-business-approved-other-vendors-pending':
    'OpenAI business verification is approved. Other vendor enrollment and verification remain pending. This does not establish approval of this plugin.',
}[config.publisher?.identityStatus]
if (!publisherIdentityNotice) throw new Error('Unknown publisher verification status.')
if (typeof publisher !== 'string' || !publisher.trim() || publisher !== publisher.trim())
  throw new Error('The integration publisher must have an explicit legal name.')
if (
  typeof publisherDisplayName !== 'string' ||
  !publisherDisplayName.trim() ||
  publisherDisplayName !== publisherDisplayName.trim()
)
  throw new Error('The integration publisher must have an explicit display name.')
const catalogBytes = await read(
  'developer-platform/packages/mcp-server/src/generated/domainCatalog.json',
)
const catalog = JSON.parse(catalogBytes)
const catalogNames = Object.keys(catalog).sort()
const contractSource = await json('openapi/source.json')
const names = (tools) => tools.map((tool) => tool.name).sort()
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const resource = new URL(config.mcpUrl)
if (
  resource.protocol !== 'https:' ||
  resource.href !== config.mcpUrl ||
  resource.search ||
  resource.hash ||
  resource.username ||
  resource.password
)
  throw new Error('The draft MCP endpoint must be an exact canonical HTTPS URL.')

async function discover(clientId) {
  // Local metadata exchange only: this client cannot contact TeamGrid or mutate data.
  const handler = createTeamGridMcpHttpHandler({
    resourceUrl: config.mcpUrl,
    issuerUrl: `${resource.origin}/`,
    region: 'de',
    cellId: 'package-fixture',
    toolProfile: 'full',
    enabled: () => true,
    writesEnabled: () => true,
    admitRequest: async () => true,
    verifyAccessToken: async () => ({
      active: true,
      audience: config.mcpUrl,
      issuer: `${resource.origin}/`,
      clientId,
      subjectId: 'package-fixture',
      workspaceId: 'package-fixture',
      grantId: 'package-fixture',
      region: 'de',
      cellId: 'package-fixture',
      scopes: ['workspace:read'],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    }),
    createDelegatedClient: async () => ({
      workspace: { get: async () => ({ data: { id: 'package-fixture' } }) },
    }),
  })
  try {
    const tools = []
    let cursor
    let id = 0
    do {
      const response = await handler.fetch(
        new Request(config.mcpUrl, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer package-fixture',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++id,
            method: 'tools/list',
            params: cursor ? { cursor } : {},
          }),
        }),
      )
      if (!response.ok) throw new Error(`Local tool discovery failed: ${response.status}.`)
      const body = await response.text()
      const payload = response.headers.get('content-type')?.includes('text/event-stream')
        ? body
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6)
        : body
      const result = JSON.parse(payload).result
      if (!result?.tools || id > 10) throw new Error('Invalid bounded catalog discovery.')
      tools.push(...result.tools)
      cursor = result.nextCursor
    } while (cursor)
    if (!equal(names(tools), catalogNames))
      throw new Error('Package discovery differs from the full canonical catalog.')
    return tools.sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    await handler.close()
  }
}

const openaiTools = await discover('https://chatgpt.com/oauth/client.json')
const claudeTools = await discover('https://claude.ai/oauth/claude-code-client-metadata')
const microsoftTools = await discover('microsoft365-package-fixture')
if (
  catalogNames.length !== 208 ||
  openaiTools.filter((tool) => tool.annotations.readOnlyHint).length !== 84
)
  throw new Error('Review the full integration baseline before changing its 208/84/124 inventory.')
for (let i = 0; i < openaiTools.length; i++) {
  const a = openaiTools[i],
    c = claudeTools[i],
    m = microsoftTools[i]
  if (
    !equal(a.inputSchema, c.inputSchema) ||
    !equal(a.inputSchema, m.inputSchema) ||
    !equal(a.securitySchemes, c.securitySchemes) ||
    !equal(a.securitySchemes, m.securitySchemes)
  )
    throw new Error(`Host presentation changed the input or consent contract: ${a.name}.`)
  if (c.annotations.destructiveHint !== !c.annotations.readOnlyHint)
    throw new Error(`Claude write confirmation is missing: ${c.name}.`)
}

const schemaSources = await json('integrations/schemas/sources.json')
const validators = {}
for (const source of schemaSources) {
  const bytes = await read(`integrations/schemas/${source.file}`)
  if (sha256(bytes) !== source.sha256) throw new Error(`Pinned schema changed: ${source.file}.`)
  const schema = JSON.parse(bytes)
  const Validator = schema.$schema.includes('2020-12') ? Ajv2020 : AjvDraft4
  // Microsoft publishes draft-04 documents with later applicator keywords.
  // Ajv's draft-04 adapter also implements if/then and propertyNames; tests below
  // require the consequential auth/reference constraints to be enforced.
  const validator = new Validator({ strict: false, allErrors: true })
  addFormats(validator)
  validators[source.file] = validator.compile(schema)
}
function validate(schema, value) {
  const validator = validators[schema]
  if (!validator(value)) throw new Error(`${schema}: ${JSON.stringify(validator.errors)}`)
}

const files = new Map()
const put = (path, value) =>
  files.set(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : encode(value))
const license = await read('LICENSE')
const skillNames = (await readdir(new URL('integrations/shared/skills/', repository))).sort()
const description =
  'Work with TeamGrid projects, tasks, planning, content, CRM and workspace administration.'
const blockedPrivacy =
  config.privacyUrl ?? 'https://example.invalid/teamgrid/privacy-not-configured'
const blockedTerms = config.termsUrl ?? 'https://example.invalid/teamgrid/terms-not-configured'
const authReference = config.microsoft365.oauthReferenceId ?? 'UNREGISTERED-TEAMGRID-OAUTH'
const legalUrlNotice =
  config.privacyUrl && config.termsUrl
    ? 'Existing public TeamGrid privacy and account terms URLs are configured. Their MCP-specific disclosures still require review.'
    : 'Privacy/terms URLs are unresolved; example.invalid values are deliberate blockers.'

async function common(path) {
  put(`${path}/LICENSE`, license)
  for (const name of skillNames)
    put(
      `${path}/skills/${name}/SKILL.md`,
      await read(`integrations/shared/skills/${name}/SKILL.md`),
    )
  put(
    `${path}/README.md`,
    `# TeamGrid integration draft\n\n${description}\n\nPublisher: ${publisher}. ${publisherIdentityNotice}\n\nConnect one TeamGrid workspace through OAuth. The full business catalog contains 208 tools (84 reads and 124 writes). Current workspace roles, sharing, locks and separately approved scopes apply to every call. No API key belongs in this package or in chat.\n\n## Data flow\n\nThe remote connector sends the selected tool name and arguments to ${config.mcpUrl}; the host receives the permitted TeamGrid response. Arguments and responses can contain workspace, project, task, contact, planning, time, content and file/export data, including personal data. An authorized write changes TeamGrid records. Returned data becomes available to the AI host under that host's account and data settings.\n\nThe proposed global gateway processes request and response payloads in Germany before routing to the workspace's DE or US cell. US regional storage therefore does not mean US-only processing. OAuth routing and browser state use private gateway storage with bounded lifetimes; existing TeamGrid records follow TeamGrid retention. This package contains no local executable, hooks or additional data destinations. Actual hosting, retention and MCP-specific legal disclosures must be confirmed before submission.\n\nThis is a generated, unqualified development package. Its proposed global endpoint is not deployed by this build. ${legalUrlNotice} Microsoft OAuth registration remains unresolved; UNREGISTERED values are deliberate blockers. Read integrations/README.md in the source repository before testing or preparing a submission. This package is not ready to publish.\n`,
  )
}

const oa = 'plugins/openai/teamgrid'
await common(oa)
const oaManifest = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'teamgrid',
  version: config.version,
  description,
  author: { name: publisher, url: config.websiteUrl },
  homepage: config.websiteUrl,
  repository: 'https://github.com/TeamGrid/developer-platform',
  license: 'MIT',
  extensions: {
    'com.openai': {
      interface: {
        displayName: 'TeamGrid',
        shortDescription: 'Projects, tasks, planning and team operations',
        longDescription: description,
        developerName: publisher,
        category: 'Productivity',
        capabilities: ['Read', 'Write'],
        websiteURL: config.websiteUrl,
        privacyPolicyURL: blockedPrivacy,
        termsOfServiceURL: blockedTerms,
        defaultPrompt: [
          'Summarize the current TeamGrid project status.',
          'Create the TeamGrid task I describe.',
        ],
        brandColor: '#355CFD',
        composerIcon: './assets/icon.png',
        logo: './assets/icon.png',
      },
    },
  },
}
const oaMcp = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { teamgrid: { type: 'streamable-http', url: config.mcpUrl } },
}
validate('agent-plugin-1.0.0.json', oaManifest)
validate('agent-mcp-1.0.0.json', oaMcp)
put(`${oa}/plugin.json`, oaManifest)
put(`${oa}/mcp.json`, oaMcp)
put(`${oa}/assets/icon.png`, await read('integrations/shared/assets/color.png'))

const cl = 'plugins/claude/teamgrid'
await common(cl)
put(`${cl}/.claude-plugin/plugin.json`, {
  name: 'teamgrid',
  displayName: 'TeamGrid',
  version: config.version,
  description,
  author: { name: publisher, url: config.websiteUrl },
  homepage: config.websiteUrl,
  repository: 'https://github.com/TeamGrid/developer-platform',
  license: 'MIT',
  icon: './assets/icon.png',
  privacyPolicyUrl: blockedPrivacy,
  termsOfServiceUrl: blockedTerms,
})
put(`${cl}/.mcp.json`, { mcpServers: { teamgrid: { type: 'http', url: config.mcpUrl } } })
put(`${cl}/assets/icon.png`, await read('integrations/shared/assets/color.png'))

const ms = 'plugins/microsoft365/teamgrid'
await common(ms)
const appManifest = {
  $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json',
  manifestVersion: '1.29',
  version: config.version,
  id: config.microsoft365.appId,
  developer: {
    name: publisherDisplayName,
    websiteUrl: config.websiteUrl,
    privacyUrl: blockedPrivacy,
    termsOfUseUrl: blockedTerms,
  },
  name: { short: 'TeamGrid', full: 'TeamGrid for Microsoft 365 Copilot' },
  description: { short: 'Projects, tasks, planning and team operations', full: description },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#355CFD',
  agentSkills: skillNames.map((name) => ({ folder: `./skills/${name}` })),
  agentConnectors: [
    {
      id: 'teamgrid',
      displayName: 'TeamGrid',
      description,
      toolSource: {
        remoteMcpServer: {
          mcpServerUrl: config.mcpUrl,
          authorization: { type: 'OAuthPluginVault', referenceId: authReference },
        },
      },
    },
  ],
  copilotAgents: { declarativeAgents: [{ id: 'teamgrid', file: 'declarativeAgent.json' }] },
}
const instructions = await read('integrations/shared/agent-instructions.md')
const agent = {
  $schema:
    'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.6/schema.json',
  version: 'v1.6',
  name: 'TeamGrid',
  description,
  instructions: instructions.toString().trim(),
  actions: [{ id: 'teamgrid-business-tools', file: 'plugin.json' }],
}
const msPlugin = {
  $schema: 'https://developer.microsoft.com/json-schemas/copilot/plugin/v2.4/schema.json',
  schema_version: 'v2.4',
  name_for_human: 'TeamGrid',
  namespace: 'teamgrid',
  description_for_human: description,
  description_for_model: instructions.toString().trim(),
  functions: microsoftTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.annotations.readOnlyHint
      ? {}
      : {
          capabilities: {
            confirmation: {
              type: 'AdaptiveCard',
              title: 'Confirm TeamGrid change',
              body: `Confirm the requested TeamGrid action: ${tool.title}.`,
              isNonConsequential: false,
            },
          },
        }),
  })),
  runtimes: [
    {
      type: 'RemoteMCPServer',
      auth: { type: 'OAuthPluginVault', reference_id: authReference },
      run_for_functions: microsoftTools.map((tool) => tool.name),
      spec: { url: config.mcpUrl, mcp_tool_description: { file: 'tools.json' } },
    },
  ],
}
validate('microsoft-app-1.29.json', appManifest)
validate('microsoft-declarative-agent-1.6.json', agent)
validate('microsoft-plugin-2.4.json', msPlugin)
// Reject a silently ignored conditional keyword in the upstream mixed-dialect schemas.
const missingReference = structuredClone(appManifest)
delete missingReference.agentConnectors[0].toolSource.remoteMcpServer.authorization.referenceId
if (validators['microsoft-app-1.29.json'](missingReference))
  throw new Error('Microsoft OAuth reference validation is ineffective.')
put(`${ms}/manifest.json`, appManifest)
put(`${ms}/declarativeAgent.json`, agent)
put(`${ms}/plugin.json`, msPlugin)
put(
  `${ms}/tools.json`,
  `{"tools":[\n${microsoftTools.map((tool) => JSON.stringify(tool)).join(',\n')}\n]}\n`,
)
put(`${ms}/color.png`, await read('integrations/shared/assets/color.png'))
put(`${ms}/outline.png`, await read('integrations/shared/assets/outline.png'))

const matrix = openaiTools.map((tool, i) => ({
  name: tool.name,
  operationId: catalog[tool.name].operationId,
  domain: catalog[tool.name].domain,
  scopes: tool.securitySchemes[0].scopes,
  concurrency: catalog[tool.name].concurrency,
  idempotency: catalog[tool.name].idempotency,
  annotations: {
    openai: tool.annotations,
    anthropic: claudeTools[i].annotations,
    microsoft365: microsoftTools[i].annotations,
  },
  hostAcceptance: 'pending',
}))
put('integrations/generated/tool-matrix.json', matrix)
const blockers = [
  'Global MCP endpoint and issuer are proposed; DE/US routing and old-grant compatibility are unqualified.',
  'Remaining publisher registrations, MCP-specific legal disclosures and the full review workspace require verification.',
  'Microsoft OAuth client/reference registration and public package eligibility are unresolved.',
  'Real-host OAuth escalation, file/export behavior and all 208 operations require acceptance evidence.',
  'Claude hosted CIMD URL/client_id currently differ; resolve with Anthropic or register an explicit approved client.',
]
put('integrations/generated/build-evidence.json', {
  status: 'draft-unqualified',
  version: config.version,
  publisher: config.publisher,
  legalUrls: {
    privacy: config.privacyUrl,
    terms: config.termsUrl,
    status: config.legalUrlStatus ?? 'unconfigured',
  },
  proposedEndpoint: config.mcpUrl,
  apiSource: contractSource,
  catalogSha256: sha256(catalogBytes),
  counts: { tools: 208, reads: 84, writes: 124 },
  skills: skillNames,
  microsoftTarget: 'Microsoft 365 Copilot including Cowork',
  blockers,
  files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
})

for (const [path, content] of files) {
  const target = new URL(path, repository)
  if (checking) {
    const actual = await readFile(target)
    if (!actual.equals(Buffer.from(content)))
      throw new Error(`Generated integration artifact is stale: ${path}.`)
  } else {
    await mkdir(new URL('./', target), { recursive: true })
    await writeFile(target, content)
  }
}
// Packages must be self-contained, and stale files cannot silently enter a ZIP.
async function inventory(path) {
  const directory = new URL(`${path}/`, repository)
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${path}/${entry.name}`
    if (entry.isDirectory()) result.push(...(await inventory(file)))
    else if (entry.isFile()) result.push(file)
    else throw new Error(`Package contains a symlink or unsupported entry: ${file}.`)
  }
  return result.sort()
}
for (const path of [oa, cl, ms]) {
  const expected = [...files.keys()].filter((file) => file.startsWith(`${path}/`)).sort()
  if (!equal(await inventory(path), expected))
    throw new Error(`Unexpected files in package: ${path}.`)
}
console.log(
  `${checking ? 'Verified' : 'Built'} 3 draft integrations: 208 tools, 84 reads, 124 writes, ${skillNames.length} shared workflows. Public release remains unqualified.`,
)

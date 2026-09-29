import type { TeamGridClient } from '@teamgrid/api-client'
import { sensitiveBrowserAuthorizationScopes } from '@teamgrid/cli'
import { enabledMcpTools, type McpToolName, type McpToolProfile } from './toolProfiles.js'
import { toolScopes } from './toolScopes.js'
import { workWriteTools } from './workTools.js'

type SetupOptions = {
  allowTools?: readonly McpToolName[]
  denyTools?: readonly McpToolName[]
  toolProfile: McpToolProfile
}

/** Human-facing setup diagnostics only; never registered as an MCP tool. */
export function describeMcpAccess(options: SetupOptions) {
  const tools = enabledMcpTools(options.toolProfile, options)
  const requiredScopes = [...new Set(tools.flatMap((tool) => [...toolScopes[tool]]))].sort()
  const browserBlockedScopes = requiredScopes.filter((scope) =>
    sensitiveBrowserAuthorizationScopes.includes(scope),
  )
  const writeTools = tools.filter((tool) => (workWriteTools as readonly string[]).includes(tool))
  return {
    browserLogin: {
      blockedScopes: browserBlockedScopes,
      scopeArguments: requiredScopes.length ? ['--scope', requiredScopes.join(',')] : [],
      supported: requiredScopes.length > 0 && browserBlockedScopes.length === 0,
      guidance: browserBlockedScopes.length
        ? 'Create a narrowly scoped personal credential in Developer settings and import it with teamgrid auth login --token-stdin, or explicitly filter out tools requiring these scopes. Browser login cannot grant sensitive scopes yet.'
        : 'Use the exact scope arguments with teamgrid auth login. Browser login must be enabled in your TeamGrid cell.',
    },
    requiredScopes,
    toolProfile: options.toolProfile,
    tools,
    writeTools,
  }
}

export async function checkMcpAccess(client: TeamGridClient, options: SetupOptions) {
  const plan = describeMcpAccess(options)
  // Always use the fresh server context, never the local profile's cached scopes.
  const context = await client.authorization.getContext()
  const granted = new Set(context.data.attributes.scopes)
  const missingScopes = plan.requiredScopes.filter((scope) => !granted.has(scope))
  const unavailableTools = plan.tools.filter((tool) =>
    toolScopes[tool].some((scope) => !granted.has(scope)),
  )
  // A scope alone does not prove current membership, workspace state or product access.
  const workspace = granted.has('workspace:read') ? await client.workspace.get() : undefined
  return {
    ...plan,
    authenticated: true,
    missingScopes,
    ready: missingScopes.length === 0 && Boolean(workspace),
    unavailableTools,
    workspace: workspace
      ? { id: workspace.data.id, region: client.location.region, cellId: client.location.cellId }
      : null,
    limitation:
      'This checks authentication, workspace access and tool scopes. Each operation still checks current resource, role and sharing permissions.',
  }
}

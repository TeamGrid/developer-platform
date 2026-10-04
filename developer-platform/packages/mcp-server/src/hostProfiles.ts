import { z } from 'zod'
import { usesChatGptToolChallenges } from './toolAuthorization.js'

export type McpHostProfile = 'standard' | 'openai' | 'anthropic' | 'microsoft365'
export type McpHostClient = Readonly<{ clientId: string; host: McpHostProfile }>

const clientsSchema = z
  .array(
    z
      .object({
        clientId: z.string().min(1).max(2048),
        host: z.enum(['standard', 'openai', 'anthropic', 'microsoft365']),
      })
      .strict(),
  )
  .max(64)

/** Operator configuration for pre-registered clients, never a request parameter. */
export function parseMcpHostClients(value: string | undefined): readonly McpHostClient[] {
  const clients = clientsSchema.parse(value ? JSON.parse(value) : [])
  if (new Set(clients.map((client) => client.clientId)).size !== clients.length)
    throw new Error('Duplicate MCP host client identity.')
  return clients.map((client) => Object.freeze(client))
}

/** Only a token's freshly verified OAuth identity selects the presentation policy. */
export function resolveMcpHostProfile(
  verifiedClientId: string,
  clients: readonly McpHostClient[] = [],
): McpHostProfile {
  const registered = clients.find((client) => client.clientId === verifiedClientId)
  if (registered) return registered.host
  if (usesChatGptToolChallenges(verifiedClientId)) return 'openai'
  // Exact published identities; callback URLs and user-agent strings are not identities.
  if (
    [
      'https://claude.ai/oauth/claude-code-client-metadata',
      'https://claude.ai/oauth/mcp-oauth-client-metadata',
    ].includes(verifiedClientId)
  )
    return 'anthropic'
  return 'standard'
}

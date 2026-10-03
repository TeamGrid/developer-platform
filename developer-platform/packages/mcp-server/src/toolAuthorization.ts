import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  type CallToolResult,
  OAuthError,
  OAuthErrorCode,
  type ScopeChallenge,
} from '@modelcontextprotocol/server'
import { requiredToolScopes } from './scopeRequirements.js'
import type { McpToolName } from './toolProfiles.js'

/** Select a presentation adapter from the verified OAuth identity, never HTTP hints. */
export function usesChatGptToolChallenges(clientId: string): boolean {
  return /^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(clientId)
}

export function toolSecuritySchemes(name: McpToolName) {
  const scopes = new Set(['workspace:read', ...requiredToolScopes(name, {})])
  // Reviewing the current comment is required before its resource-derived consent.
  if (
    [
      'teamgrid_comment_get',
      'teamgrid_comment_update',
      'teamgrid_comment_archive',
      'teamgrid_comment_restore',
    ].includes(name)
  )
    scopes.add('comments:read')
  return [{ type: 'oauth2' as const, scopes: [...scopes].sort() }]
}

/** Follow ChatGPT's documented tool-result OAuth challenge contract. */
export function toolConsentRequired(
  challenge: ScopeChallenge,
  authInfo: AuthInfo,
  action?: string,
): CallToolResult {
  const description =
    action === 'teamgrid_task_create'
      ? 'To create this task, TeamGrid needs permission to create and edit tasks. Please approve the additional access.'
      : 'This action needs additional TeamGrid permissions. Please approve the additional access. Your current connection remains valid.'
  // Keep the previously approved scopes in the next consent request. Refresh alone
  // cannot widen a grant; the authorization server still requires explicit consent.
  const response = bearerAuthChallengeResponse(
    new OAuthError(OAuthErrorCode.InsufficientScope, description),
    {
      requiredScopes: [...new Set([...authInfo.scopes, ...challenge.scopes])].sort(),
      resourceMetadataUrl: authInfo.resourceMetadataUrl,
    },
  )
  return {
    isError: true,
    content: [{ type: 'text', text: description }],
    _meta: { 'mcp/www_authenticate': [response.headers.get('WWW-Authenticate') as string] },
  }
}

import { describe, expect, it } from 'vitest'
import { parseMcpHostClients, resolveMcpHostProfile } from './hostProfiles.js'

describe('verified OAuth host presentation', () => {
  it('matches exact Claude identities and rejects lookalikes and callback URLs', () => {
    expect(resolveMcpHostProfile('https://claude.ai/oauth/claude-code-client-metadata')).toBe(
      'anthropic',
    )
    expect(resolveMcpHostProfile('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe(
      'anthropic',
    )
    for (const id of [
      'https://claude.ai.evil.test/oauth/claude-code-client-metadata',
      'https://claude.ai/oauth/claude-code-client-metadata?hint=claude',
      'https://claude.ai/api/mcp/auth_callback',
      'Claude',
    ])
      expect(resolveMcpHostProfile(id)).toBe('standard')
  })

  it('uses only the operator registry for static Microsoft and Claude clients', () => {
    const clients = parseMcpHostClients(
      JSON.stringify([
        { clientId: 'm365-static', host: 'microsoft365' },
        { clientId: 'claude-static', host: 'anthropic' },
      ]),
    )
    expect(resolveMcpHostProfile('m365-static', clients)).toBe('microsoft365')
    expect(resolveMcpHostProfile('claude-static', clients)).toBe('anthropic')
    expect(resolveMcpHostProfile('m365-static-foreign', clients)).toBe('standard')
    expect(Object.isFrozen(clients[0])).toBe(true)
  })

  it('rejects duplicate, unknown, oversized or ambiguous operator entries at startup', () => {
    expect(parseMcpHostClients(undefined)).toEqual([])
    for (const entries of [
      [
        { clientId: 'a', host: 'anthropic' },
        { clientId: 'a', host: 'openai' },
      ],
      [{ clientId: 'a', host: 'unknown' }],
      [{ clientId: 'a', host: 'anthropic', userAgent: 'Claude' }],
      [{ clientId: '', host: 'standard' }],
      Array.from({ length: 65 }, (_, i) => ({ clientId: `${i}`, host: 'standard' })),
    ])
      expect(() => parseMcpHostClients(JSON.stringify(entries))).toThrow()
  })
})

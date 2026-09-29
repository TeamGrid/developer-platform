import { TeamGridApiError } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { resourceScopeChallenge, toolScopeChallenge } from './scopeRequirements.js'

const denied = (header = 'Bearer error="insufficient_scope", scope="tasks:read"') =>
  new TeamGridApiError({
    status: 403,
    errors: [{ code: 'insufficient_scope', status: '403', title: 'Forbidden', detail: 'Denied.' }],
    transport: {
      status: 403,
      attempts: 1,
      headers: { 'www-authenticate': header },
      requestId: 'r1',
      rateLimit: {},
    },
  })
const context = (scopes: string[]) => ({
  request: {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name: 'teamgrid_comment_update', arguments: { id: 'comment1' } },
  },
  authInfo: { token: 'opaque', clientId: 'host', scopes },
})

describe('resource-derived OAuth consent', () => {
  it('accepts only the closed API read-scope challenge', () => {
    expect(resourceScopeChallenge(denied())).toEqual(['tasks:read'])
    for (const header of [
      'Bearer error="insufficient_scope", scope="credentials:write"',
      'Bearer error="insufficient_scope", scope="tasks:read", unsafe="x"',
      'Bearer scope="tasks:read"',
      'customer-controlled text',
    ])
      expect(resourceScopeChallenge(denied(header))).toEqual([])
    expect(resourceScopeChallenge(new Error('tasks:read'))).toEqual([])
    expect(resourceScopeChallenge(new TeamGridApiError({ status: 403 }))).toEqual([])
  })
  it('asks for reviewed comment access before probing and never runs a mutation', async () => {
    const get = vi.fn(async () => {
      throw denied()
    })
    const update = vi.fn()
    const challenge = toolScopeChallenge('teamgrid_comment_update', {
      comments: { get, update },
    } as never)
    expect(await challenge(context(['workspace:read', 'comments:write']))).toEqual({
      scopes: ['comments:write', 'workspace:read', 'comments:read'],
    })
    expect(get).not.toHaveBeenCalled()
    expect(await challenge(context(['workspace:read', 'comments:write', 'comments:read']))).toEqual(
      { scopes: ['comments:read', 'comments:write', 'tasks:read', 'workspace:read'] },
    )
    expect(get).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalled()
  })
  it('does not turn role denial, missing data or outages into additional consent', async () => {
    for (const error of [
      new TeamGridApiError({ status: 403 }),
      new TeamGridApiError({ status: 404 }),
      new Error('outage'),
    ]) {
      const challenge = toolScopeChallenge('teamgrid_export_get', {
        exports: {
          get: async () => {
            throw error
          },
        },
      } as never)
      expect(await challenge(context(['exports:read']))).toBeUndefined()
    }
  })
})

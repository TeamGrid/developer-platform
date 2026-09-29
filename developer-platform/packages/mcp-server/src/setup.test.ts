import { describe, expect, it, vi } from 'vitest'
import { parseMcpArguments } from './config.js'
import { checkMcpAccess, describeMcpAccess } from './setup.js'

describe('human MCP setup diagnostics', () => {
  it('explains the sensitive browser-login gap without silently narrowing the profile', () => {
    const plan = describeMcpAccess({ toolProfile: 'core' })
    expect(plan.tools).toHaveLength(22)
    expect(plan.writeTools).toEqual([])
    expect(plan.browserLogin.supported).toBe(false)
    expect(plan.browserLogin.blockedScopes).toEqual(['task-recurrences:read'])
    expect(plan.requiredScopes).toContain('task-recurrences:read')
  })

  it('derives exact narrowed write scopes and preserves the workspace requirement', () => {
    const plan = describeMcpAccess({
      allowTools: ['teamgrid_task_update', 'teamgrid_task_get'],
      toolProfile: 'work',
    })
    expect(plan.requiredScopes).toEqual(['tasks:read', 'tasks:write', 'workspace:read'])
    expect(plan.writeTools).toEqual(['teamgrid_task_update'])
    expect(plan.browserLogin.supported).toBe(true)
    expect(() =>
      describeMcpAccess({
        allowTools: ['teamgrid_task_update'],
        toolProfile: 'core',
      }),
    ).toThrow('outside')
  })

  it('uses live scopes to identify unavailable tools, never exposes credential context', async () => {
    const getContext = vi.fn(async () => ({
      data: {
        id: 'private-credential-id',
        attributes: { scopes: ['workspace:read'] },
      },
    }))
    const client = {
      authorization: { getContext },
      location: { cellId: 'de-test', region: 'de' },
      workspace: {
        get: vi.fn(async () => ({
          data: {
            id: 'workspace-test',
            attributes: {
              name: 'Private workspace name',
            },
          },
        })),
      },
    }
    const options = {
      allowTools: ['teamgrid_workspace_get', 'teamgrid_tasks_list'] as const,
      toolProfile: 'core' as const,
    }
    const report = await checkMcpAccess(client as never, options)
    expect(report.ready).toBe(false)
    expect(report.missingScopes).toEqual(['tasks:read'])
    expect(report.unavailableTools).toEqual(['teamgrid_tasks_list'])
    expect(JSON.stringify(report)).not.toContain('private-credential-id')
    expect(JSON.stringify(report)).not.toContain('Private workspace name')
    getContext.mockRejectedValueOnce(new Error('credential revoked'))
    await expect(checkMcpAccess(client as never, options)).rejects.toThrow('credential revoked')
  })

  it('never reports readiness when the current workspace is locked or missing', async () => {
    const client = {
      authorization: {
        getContext: async () => ({ data: { attributes: { scopes: ['workspace:read'] } } }),
      },
      workspace: {
        get: vi.fn(async () => {
          throw new Error('workspace locked')
        }),
      },
    }
    await expect(
      checkMcpAccess(client as never, {
        allowTools: ['teamgrid_workspace_get'],
        toolProfile: 'core',
      }),
    ).rejects.toThrow('workspace locked')
    const missing = await checkMcpAccess(
      {
        ...client,
        authorization: { getContext: async () => ({ data: { attributes: { scopes: [] } } }) },
      } as never,
      { allowTools: ['teamgrid_workspace_get'], toolProfile: 'core' },
    )
    expect(missing.ready).toBe(false)
    expect(missing.workspace).toBeNull()
    expect(client.workspace.get).toHaveBeenCalledTimes(1)
  })

  it('parses standalone diagnostics and rejects combined modes', () => {
    expect(parseMcpArguments(['--check', '--tool-profile', 'work', '--profile', 'test'])).toEqual({
      diagnostic: 'check',
      toolProfile: 'work',
      profile: 'test',
    })
    expect(parseMcpArguments(['--tool-profile', 'core', '--explain-scopes']).diagnostic).toBe(
      'explain-scopes',
    )
    expect(() => parseMcpArguments(['--check', '--explain-scopes'])).toThrow('one diagnostic mode')
  })

  it('does not report a core write ready when an older API cannot acknowledge required CAS', async () => {
    const client = {
      authorization: {
        getContext: async () => ({
          data: { attributes: { scopes: ['workspace:read', 'tasks:write'] } },
        }),
      },
      workspace: {
        get: vi.fn(async () => ({
          data: { id: 'workspace-test' },
          transport: { headers: {} as Record<string, string> },
        })),
      },
      location: { cellId: 'de-test', region: 'de' },
    }
    const options = { toolProfile: 'full' as const, allowTools: ['teamgrid_task_update'] as const }
    const closed = await checkMcpAccess(client as never, options)
    expect(closed.missingScopes).toEqual([])
    expect(closed.ready).toBe(false)
    expect(closed.unavailableTools).toEqual(['teamgrid_task_update'])
    client.workspace.get.mockResolvedValue({
      data: { id: 'workspace-test' },
      transport: { headers: { 'x-teamgrid-resource-cas': 'required-v1' } },
    })
    const supported = await checkMcpAccess(client as never, options)
    expect(supported.ready).toBe(true)
    expect(supported.resourceCas).toEqual({ required: true, acknowledged: true })
    expect(supported.limitation).toContain('does not qualify server CAS activation')
  })
})

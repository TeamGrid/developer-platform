import { describe, expect, it } from 'vitest'
import { runConformancePlan } from './run.mjs'

describe('conformance plan command', () => {
  it('renders the complete plan without exposing ambient credentials', async () => {
    const rendered = await runConformancePlan({
      arguments_: ['--mode', 'plan', '--format', 'json'],
      environment: {
        TEAMGRID_CONFORMANCE_V0_TOKEN: 'legacy-secret',
        TEAMGRID_CONFORMANCE_V1_TOKEN: 'stable-secret',
      },
    })
    const plan = JSON.parse(rendered)

    expect(plan).toMatchObject({
      contractVersion: '1.1.0',
      mode: 'plan',
      summary: { total: 323 },
    })
    expect(plan.operations).toHaveLength(323)
    expect(rendered).not.toContain('legacy-secret')
    expect(rendered).not.toContain('stable-secret')
  })

  it('refuses to pretend that a live run exists before its runner is selected', async () => {
    await expect(
      runConformancePlan({
        arguments_: ['--mode', 'read-only'],
        environment: {},
      }),
    ).rejects.toThrow('TEAMGRID_CONFORMANCE_REGION is required')
  })
})

import type { TeamGridClient } from '@teamgrid/api-client'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import { domainInputSchema, domainOutputSchema, domainToolNames } from './domainTools.js'
import { createTeamGridMcpServer } from './server.js'

describe('catalog schema lifecycle', () => {
  it('starts a full session without compiling unused validators', async () => {
    const compile = vi.spyOn(Ajv2020.prototype, 'compile')
    try {
      const server = createTeamGridMcpServer({} as TeamGridClient, { toolProfile: 'full' })
      expect(compile).not.toHaveBeenCalled()
      await server.close()
    } finally {
      compile.mockRestore()
    }
  })

  it.each(domainToolNames)('compiles strict input and both output variants for %s', (name) => {
    // Exercise compilation independently of which operations integration tests
    // happen to call. An empty response must fail the concrete output contract.
    expect(() => domainInputSchema(name)['~standard'].validate({})).not.toThrow()
    for (const legacy of [false, true]) {
      const result = domainOutputSchema(name, legacy)['~standard'].validate({})
      expect(result).toHaveProperty('issues')
    }
  })
})

import { describe, expect, expectTypeOf, it } from 'vitest'
import { TeamGridClient } from './client.js'
import type { ResourceEnvelope, TransportMetadata } from './types.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('static beta.2 core resource SDK types', () => {
  it('exposes core mutations without CAS-only options or branded ETags', () => {
    const typeContract = async () => {
      const client = new TeamGridClient({ token })

      const projectGet = await client.projects.get('project')
      const projectCreate = await client.projects.create({ name: 'Project' })
      const projectUpdate = await client.projects.update('project', {})
      expectTypeOf(projectGet).toMatchTypeOf<ResourceEnvelope<unknown>>()
      expectTypeOf(projectCreate.transport).toEqualTypeOf<Readonly<TransportMetadata>>()
      expectTypeOf(projectUpdate.transport).toEqualTypeOf<Readonly<TransportMetadata>>()

      await client.projects.archive('project')
      await client.projects.complete('project')
      await client.projects.reopen('project')
      await client.projects.restore('project')

      await client.projectTemplates.update('template', {})
      const templateArchive = await client.projectTemplates.archive('template')
      expectTypeOf(templateArchive).toEqualTypeOf<Readonly<TransportMetadata>>()
      await client.projectTemplates.restore('template')
      await client.projectTemplates.instantiate('template', { name: 'Project' })

      await client.tasks.update('task', {})
      const taskArchive = await client.tasks.archive('task')
      expectTypeOf(taskArchive).toEqualTypeOf<Readonly<TransportMetadata>>()
      await client.tasks.complete('task')
      await client.tasks.reopen('task')
      await client.tasks.restore('task')

      // @ts-expect-error Static Beta 2 core mutations do not accept If-Match.
      client.tasks.update('task', {}, { ifMatch: 'legacy' })
      // @ts-expect-error Static Beta 2 core lifecycle operations do not accept If-Match.
      client.projects.complete('project', { ifMatch: 'legacy' })
      // @ts-expect-error Static Beta 2 template instantiation does not accept If-Match.
      client.projectTemplates.instantiate('template', { name: 'Project' }, { ifMatch: 'legacy' })
    }
    expect(typeContract).toBeTypeOf('function')
  })
})

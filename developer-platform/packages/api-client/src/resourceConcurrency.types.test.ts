import { describe, expect, expectTypeOf, it } from 'vitest'
import { TeamGridClient } from './client.js'
import type {
  ProjectRevision,
  ProjectTemplateRevision,
  ResourceEnvelope,
  TaskRevision,
  TransportMetadata,
} from './types.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('stable core resource SDK types', () => {
  it('requires branded CAS preconditions for core mutations', () => {
    const typeContract = async () => {
      const client = new TeamGridClient({ token })
      const projectRevision = 'prj1-revision' as ProjectRevision
      const taskRevision = 'tsk1-revision' as TaskRevision
      const templateRevision = 'tpl1-revision' as ProjectTemplateRevision

      const projectGet = await client.projects.get('project')
      const projectCreate = await client.projects.create({ name: 'Project' })
      const projectUpdate = await client.projects.update(
        'project',
        {},
        { ifMatch: projectRevision },
      )
      expectTypeOf(projectGet).toMatchTypeOf<ResourceEnvelope<unknown>>()
      expectTypeOf(projectCreate.transport).toEqualTypeOf<Readonly<TransportMetadata>>()
      expectTypeOf(projectUpdate.transport).toEqualTypeOf<Readonly<TransportMetadata>>()

      await client.projects.archive('project', { ifMatch: projectRevision })
      await client.projects.complete('project', { ifMatch: projectRevision })
      await client.projects.reopen('project', { ifMatch: projectRevision })
      await client.projects.restore('project', { ifMatch: projectRevision })

      await client.projectTemplates.update('template', {}, { ifMatch: templateRevision })
      const templateArchive = await client.projectTemplates.archive('template', {
        ifMatch: templateRevision,
      })
      expectTypeOf(templateArchive).toEqualTypeOf<Readonly<TransportMetadata>>()
      await client.projectTemplates.restore('template', { ifMatch: templateRevision })
      await client.projectTemplates.instantiate(
        'template',
        { name: 'Project' },
        { ifMatch: templateRevision },
      )

      await client.tasks.update('task', {}, { ifMatch: taskRevision })
      const taskArchive = await client.tasks.archive('task', { ifMatch: taskRevision })
      expectTypeOf(taskArchive).toEqualTypeOf<Readonly<TransportMetadata>>()
      await client.tasks.complete('task', { ifMatch: taskRevision })
      await client.tasks.reopen('task', { ifMatch: taskRevision })
      await client.tasks.restore('task', { ifMatch: taskRevision })

      // @ts-expect-error Stable core mutations require If-Match.
      client.tasks.update('task', {})
      // @ts-expect-error Stable lifecycle mutations require If-Match.
      client.projects.complete('project')
      // @ts-expect-error Template instantiation requires If-Match.
      client.projectTemplates.instantiate('template', { name: 'Project' })
    }
    expect(typeContract).toBeTypeOf('function')
  })
})

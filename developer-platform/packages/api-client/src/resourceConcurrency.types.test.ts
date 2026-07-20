import { describe, expect, expectTypeOf, it } from 'vitest'
import { TeamGridClient } from './client.js'
import {
  canonicalProjectStrongETag,
  canonicalProjectTemplateStrongETag,
  canonicalTaskStrongETag,
} from './resourceConcurrency.js'
import type { ProjectStrongETag, ProjectTemplateStrongETag, TaskStrongETag } from './types.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('resource concurrency SDK types', () => {
  it('brands strong ETags by resource type', () => {
    expectTypeOf(canonicalTaskStrongETag('a'.repeat(64))).toEqualTypeOf<TaskStrongETag>()
    expectTypeOf(canonicalProjectStrongETag('b'.repeat(64))).toEqualTypeOf<ProjectStrongETag>()
    expectTypeOf(
      canonicalProjectTemplateStrongETag('c'.repeat(64)),
    ).toEqualTypeOf<ProjectTemplateStrongETag>()
    expect(true).toBe(true)
  })

  it('requires If-Match at compile time on exactly the 14 CAS mutations', () => {
    const typeContract = async () => {
      const client = new TeamGridClient({ token })
      const project = canonicalProjectStrongETag('a'.repeat(64))
      const template = canonicalProjectTemplateStrongETag('b'.repeat(64))
      const task = canonicalTaskStrongETag('c'.repeat(64))

      const projectGet = await client.projects.get('project')
      const projectCreate = await client.projects.create({ name: 'Project' })
      const projectUpdate = await client.projects.update('project', {}, { ifMatch: project })
      expectTypeOf(projectGet.transport.headers.etag).toEqualTypeOf<ProjectStrongETag>()
      expectTypeOf(projectCreate.transport.headers.etag).toEqualTypeOf<ProjectStrongETag>()
      expectTypeOf(projectUpdate.transport.headers.etag).toEqualTypeOf<ProjectStrongETag>()

      const templateGet = await client.projectTemplates.get('template')
      const templateCreate = await client.projectTemplates.create({
        color: '#0057ff',
        projectId: 'project',
        title: 'Template',
      })
      const templateRestore = await client.projectTemplates.restore('template', {
        ifMatch: template,
      })
      expectTypeOf(templateGet.transport.headers.etag).toEqualTypeOf<ProjectTemplateStrongETag>()
      expectTypeOf(templateCreate.transport.headers.etag).toEqualTypeOf<ProjectTemplateStrongETag>()
      expectTypeOf(
        templateRestore.transport.headers.etag,
      ).toEqualTypeOf<ProjectTemplateStrongETag>()

      const taskGet = await client.tasks.get('task')
      const taskCreate = await client.tasks.create({ name: 'Task' })
      const taskRestore = await client.tasks.restore('task', { ifMatch: task })
      expectTypeOf(taskGet.transport.headers.etag).toEqualTypeOf<TaskStrongETag>()
      expectTypeOf(taskCreate.transport.headers.etag).toEqualTypeOf<TaskStrongETag>()
      expectTypeOf(taskRestore.transport.headers.etag).toEqualTypeOf<TaskStrongETag>()

      client.projects.update('project', {}, { ifMatch: project })
      client.projects.archive('project', { ifMatch: project })
      client.projects.complete('project', { ifMatch: project })
      client.projects.reopen('project', { ifMatch: project })
      client.projects.restore('project', { ifMatch: project })
      client.projectTemplates.update('template', {}, { ifMatch: template })
      const templateArchive = await client.projectTemplates.archive('template', {
        ifMatch: template,
      })
      expectTypeOf(templateArchive.headers.etag).toEqualTypeOf<ProjectTemplateStrongETag>()
      client.projectTemplates.restore('template', { ifMatch: template })
      client.projectTemplates.instantiate('template', { name: 'Project' }, { ifMatch: template })
      client.tasks.update('task', {}, { ifMatch: task })
      const taskArchive = await client.tasks.archive('task', { ifMatch: task })
      expectTypeOf(taskArchive.headers.etag).toEqualTypeOf<TaskStrongETag>()
      client.tasks.complete('task', { ifMatch: task })
      client.tasks.reopen('task', { ifMatch: task })
      client.tasks.restore('task', { ifMatch: task })

      // @ts-expect-error CAS mutation requires If-Match.
      client.projects.update('project', {})
      // @ts-expect-error CAS mutation requires If-Match.
      client.projects.archive('project')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projects.complete('project')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projects.reopen('project')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projects.restore('project')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projectTemplates.update('template', {})
      // @ts-expect-error CAS mutation requires If-Match.
      client.projectTemplates.archive('template')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projectTemplates.restore('template')
      // @ts-expect-error CAS mutation requires If-Match.
      client.projectTemplates.instantiate('template', { name: 'Project' })
      // @ts-expect-error CAS mutation requires If-Match.
      client.tasks.update('task', {})
      // @ts-expect-error CAS mutation requires If-Match.
      client.tasks.archive('task')
      // @ts-expect-error CAS mutation requires If-Match.
      client.tasks.complete('task')
      // @ts-expect-error CAS mutation requires If-Match.
      client.tasks.reopen('task')
      // @ts-expect-error CAS mutation requires If-Match.
      client.tasks.restore('task')

      // @ts-expect-error Project ETags cannot be used for task mutations.
      client.tasks.update('task', {}, { ifMatch: project })
      // @ts-expect-error Task ETags cannot be used for template mutations.
      client.projectTemplates.archive('template', { ifMatch: task })
    }
    expect(typeContract).toBeTypeOf('function')
  })
})

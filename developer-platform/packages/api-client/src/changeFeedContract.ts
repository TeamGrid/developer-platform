import type { ChangeResourceType } from './types.js'

// Runtime companion to the generated OpenAPI union. The contract-surface gate
// proves completeness against both ChangeEvent.resourceType and the /changes
// query enum before packages can be released.
export const TEAMGRID_CHANGE_FEED_RESOURCE_TYPES = Object.freeze([
  'absence',
  'appointment',
  'automationDefinition',
  'automationRun',
  'callNote',
  'comment',
  'contact',
  'contactGroup',
  'customFieldDefinition',
  'document',
  'file',
  'integration',
  'list',
  'product',
  'productGroup',
  'project',
  'projectStatement',
  'projectTemplate',
  'service',
  'tag',
  'task',
  'timeEntry',
  'webhook',
] as const satisfies readonly ChangeResourceType[])

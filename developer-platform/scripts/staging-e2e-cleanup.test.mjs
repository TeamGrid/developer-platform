import { describe, expect, it } from 'vitest'
import { selectUniqueWebhookCleanupCandidateId } from './staging-e2e-cleanup.mjs'

function webhook(id, url, actions = ['task_created']) {
  return {
    attributes: { actions, url },
    id,
    type: 'webhook',
  }
}

describe('staging E2E webhook cleanup discovery', () => {
  it('selects the sole exact credential-owned candidate independent of action order', () => {
    const id = selectUniqueWebhookCleanupCandidateId(
      [
        webhook('unrelated-url', 'https://hooks.example.test/other'),
        webhook('unrelated-actions', 'https://hooks.example.test/run', ['task_updated']),
        webhook('expected', 'https://hooks.example.test/run', ['task_updated', 'task_created']),
      ],
      {
        actions: ['task_created', 'task_updated'],
        url: 'https://hooks.example.test/run',
      },
    )

    expect(id).toBe('expected')
  })

  it('returns undefined when the credential owns no exact candidate', () => {
    expect(
      selectUniqueWebhookCleanupCandidateId([], {
        actions: ['task_created'],
        url: 'https://hooks.example.test/run',
      }),
    ).toBeUndefined()
  })

  it('fails closed when cleanup discovery is ambiguous', () => {
    const resources = [
      webhook('first', 'https://hooks.example.test/run'),
      webhook('second', 'https://hooks.example.test/run'),
    ]

    expect(() =>
      selectUniqueWebhookCleanupCandidateId(resources, {
        actions: ['task_created'],
        url: 'https://hooks.example.test/run',
      }),
    ).toThrow('ambiguous (2 matches)')
  })

  it('rejects malformed discovery criteria', () => {
    expect(() =>
      selectUniqueWebhookCleanupCandidateId([], {
        actions: [],
        url: 'https://hooks.example.test/run',
      }),
    ).toThrow('non-empty array')
    expect(() =>
      selectUniqueWebhookCleanupCandidateId([], {
        actions: ['task_created'],
        url: '',
      }),
    ).toThrow('non-empty string')
  })
})

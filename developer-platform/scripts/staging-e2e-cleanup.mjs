function sortedActions(actions) {
  return [...actions].sort()
}

function hasMatchingActions(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  return sortedActions(actual).every((action, index) => action === expected[index])
}

export function selectUniqueWebhookCleanupCandidateId(resources, { actions, url }) {
  if (!Array.isArray(resources)) throw new TypeError('Webhook resources must be an array.')
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new TypeError('Expected webhook actions must be a non-empty array.')
  }
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('Expected webhook URL must be a non-empty string.')
  }

  const expectedActions = sortedActions(actions)
  const matches = resources.filter(
    (resource) =>
      resource?.type === 'webhook' &&
      resource.attributes?.url === url &&
      hasMatchingActions(resource.attributes.actions, expectedActions),
  )

  if (matches.length > 1) {
    throw new Error(`Webhook cleanup discovery is ambiguous (${matches.length} matches).`)
  }
  return matches[0]?.id
}

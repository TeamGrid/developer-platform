/** A Top-N index query never establishes exhaustive results, including zero hits. */
export function boundedSearchMetadata(data: unknown, limit: unknown) {
  return {
    complete: false,
    indexed: true,
    returned: Array.isArray(data) ? data.length : 0,
    limit: typeof limit === 'number' ? limit : 25,
    continuation: 'narrow-query-or-list',
    verification: 'read-by-id',
  }
}

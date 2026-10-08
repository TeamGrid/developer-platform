// MCP can narrow the canonical API surface without changing SDK/CLI contracts.
// Legacy workflows are disabled in the product and will be rebuilt separately.
// Match the domain, route and scope so a future workflow endpoint cannot become
// model-callable merely by appearing in a refreshed API contract.
export function mcpOperationPolicy(operations) {
  return operations.map((operation) => {
    const automation =
      operation.mcp?.domain === 'automation-write' ||
      /^automations:/.test(operation.scope || '') ||
      /^\/automation-(?:actions|definitions|runs)(?:\/|$)/.test(operation.path || '') ||
      /^automation(?:Actions|Definitions|DefinitionVersions|Runs)\./.test(operation.sdk || '')
    if (!automation) return operation
    return {
      ...operation,
      mcp: {
        exposure: 'forbidden',
        reason: 'Legacy automation workflows are excluded from MCP until the separate product rebuild.',
      },
    }
  })
}

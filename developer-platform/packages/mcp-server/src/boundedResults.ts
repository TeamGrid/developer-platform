import type { CallToolResult } from '@modelcontextprotocol/server'
import { domainCatalog } from './domainTools.js'
import { operationOutcome } from './outcomes.js'
import type { McpToolName } from './toolProfiles.js'

export const maximumToolResultBytes = 256 * 1024

/** Applied only after the original successful result passes its output schema. */
export function boundToolResult(result: CallToolResult, name: McpToolName): CallToolResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maximumToolResultBytes) return result
  const value = result.structuredContent as
    | { data?: unknown; meta?: Record<string, unknown> }
    | undefined
  if (!result.isError && domainCatalog[name].write && value?.data) {
    const resources = (Array.isArray(value.data) ? value.data : [value.data]).map((item) => ({
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      type: item.type,
      ...(typeof item.attributes?.status === 'string' ? { status: item.attributes.status } : {}),
    }))
    const meta = value.meta ?? {}
    const receipt = {
      data: {
        type: 'mutationReceipt',
        attributes: { operation: domainCatalog[name].operationId, resources },
      },
      meta: {
        ...operationOutcome(value.data, true),
        ...(typeof meta.outcome === 'string' ? { outcome: meta.outcome } : {}),
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
        ...(meta.etag ? { etag: meta.etag } : {}),
        ...(meta.resume ? { resume: meta.resume } : {}),
        omittedFields: ['resourceAttributes'],
      },
    }
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') <= maximumToolResultBytes / 2)
      return {
        content: [{ type: 'text', text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      }
  }
  const error = {
    error: {
      code: 'result_too_large',
      detail:
        'The result exceeds the MCP context limit. For lists, use a smaller page; for individual content, use the documented field continuation.',
    },
    ...(domainCatalog[name].write ? { meta: { outcome: 'unknown' } } : {}),
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: error,
    isError: true,
  }
}

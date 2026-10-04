import type { McpToolName } from './toolProfiles.js'

/** Finite operational metadata only; no tool arguments, resource IDs or error text. */
export type McpToolObservation = {
  event: 'teamgrid.mcp.tool'
  requestId: string
  tool: McpToolName
  outcome: 'completed' | 'accepted' | 'partial' | 'unknown' | 'failed' | 'authorization-required'
  isError: boolean
  authChallenge: boolean
  durationMs: number
}

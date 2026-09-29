import { createHash } from 'node:crypto'
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type RegisteredTool,
  type Tool,
} from '@modelcontextprotocol/server'

const maximumBytes = 256 * 1024
const maximumTools = 50

/** Use the public low-level handler; never depend on SDK private registries. */
export function installBoundedToolDiscovery(
  server: McpServer,
  registrations: ReadonlyMap<string, RegisteredTool>,
) {
  server.server.setRequestHandler('tools/list', (request) => {
    const tools = [...registrations]
      .filter(([, entry]) => entry.enabled)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({
        name,
        title: entry.title,
        description: entry.description,
        annotations: entry.annotations,
        inputSchema: entry.inputSchema?.['~standard'].jsonSchema.input({
          target: 'draft-2020-12',
        }) ?? { type: 'object' },
        ...(entry.outputSchema
          ? {
              outputSchema: entry.outputSchema['~standard'].jsonSchema.output({
                target: 'draft-2020-12',
              }),
            }
          : {}),
      })) as Tool[]
    const fingerprint = createHash('sha256').update(JSON.stringify(tools)).digest('hex')
    let offset = 0
    const cursor = request.params?.cursor
    if (cursor !== undefined) {
      const match = /^tgtools1\.([a-f0-9]{64})\.([1-9][0-9]{0,5})$/.exec(cursor)
      if (!match || match[1] !== fingerprint || Number(match[2]) >= tools.length)
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Tool catalog cursor is invalid or expired. Restart tools/list without a cursor.',
        )
      offset = Number(match[2])
    }
    const page: Tool[] = []
    // Reserve envelope and cursor space as well as each tool's JSON separators.
    let bytes = 1024
    for (const tool of tools.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(tool), 'utf8') + 1
      if (size + 1024 > maximumBytes)
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'A tool definition exceeds the discovery limit.',
        )
      if (page.length >= maximumTools || bytes + size > maximumBytes) break
      page.push(tool)
      bytes += size
    }
    const next = offset + page.length
    return {
      tools: page,
      ...(next < tools.length ? { nextCursor: `tgtools1.${fingerprint}.${next}` } : {}),
    }
  })
}

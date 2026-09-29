// Protocol clients differ: some aggregate pages automatically, others return one.
export async function listAllMcpTools(client) {
  const tools = []
  const cursors = new Set()
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...page.tools)
    cursor = page.nextCursor
    if (tools.length > 1000 || (cursor && cursors.has(cursor))) {
      throw new Error('MCP discovery exceeded its bound or repeated a cursor.')
    }
    if (cursor) cursors.add(cursor)
  } while (cursor)
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw new Error('MCP discovery returned duplicate tools.')
  }
  return { tools }
}

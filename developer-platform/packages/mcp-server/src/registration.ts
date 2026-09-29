import type {
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server'
import type { McpToolName } from './toolProfiles.js'

// Use standard schemas only: the deprecated raw-shape overload erases inference
// at the shared error/projection boundary.
export type RegisterTeamGridTool = <Input extends StandardSchemaWithJSON>(
  name: McpToolName,
  config: { description: string; inputSchema: Input; annotations: ToolAnnotations },
  callback: ToolCallback<Input>,
) => RegisteredTool

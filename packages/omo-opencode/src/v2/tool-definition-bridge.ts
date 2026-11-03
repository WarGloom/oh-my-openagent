import type { Hooks } from "@opencode-ai/plugin"
import type { V2PluginContext, V2Registration } from "./context-types"
import { toV1ToolName } from "./tool-names"

export async function installToolDefinitions(context: V2PluginContext, hooks: Hooks): Promise<V2Registration | undefined> {
  const handler = hooks["tool.definition"]
  if (!handler) return undefined
  const definitions = new Map<string, { description: string; parameters: unknown }>()
  for (const tool of await context.tool.list()) {
    const output = { description: tool.description, parameters: tool.input }
    await handler({ toolID: toV1ToolName(tool.id) }, output)
    definitions.set(tool.id, output)
  }
  // Native editors are synchronous. Await the V1 handlers before entering the transform.
  const registration = await context.tool.transform((editor) => {
    for (const tool of editor.list()) {
      const definition = definitions.get(tool.id)
      if (definition) editor.update(tool.id, (draft) => {
        draft.description = definition.description
        draft.input = definition.parameters
      })
    }
  })
  // MCP tools can arrive after setup. Their request definitions are an async host hook surface.
  const request = await context.session.hook("context", async (event) => {
    for (const [name, tool] of Object.entries(event.tools ?? {})) {
      const output = { description: tool.description, parameters: tool.input }
      await handler({ toolID: toV1ToolName(name) }, output)
      tool.description = output.description
      tool.input = output.parameters
    }
  })
  return { dispose: async () => {
    await request.dispose()
    await registration.dispose()
  } }
}

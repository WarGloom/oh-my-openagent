import { describe, expect, it } from "bun:test"

import { recoverUnavailableTool } from "./recover-unavailable-tool"
import type { MessageData } from "./types"

describe("recoverUnavailableTool", () => {
  it("#given a serena alias miss #when recovering #then it targets the alias tool-use part only", async () => {
    //#given
    const promptCalls: Array<{ path: { id: string }; body: { parts: Array<{ type: string; tool_use_id: string; content: string }> } }> = []
    const client = {
      session: {
        promptAsync: async (input: { path: { id: string }; body: { parts: Array<{ type: string; tool_use_id: string; content: string }> } }) => {
          promptCalls.push(input)
          return {}
        },
        messages: async () => ({ data: [] }),
      },
    }
    const failedAssistantMsg: MessageData = {
      info: {
        error: {
          message: "Model tried to call unavailable tool 'mcp__plugin_serena_serena__activate_project'. Available tools: invalid, serena_activate_project, read",
        },
      },
      parts: [
        { type: "tool_use", id: "alias-call", name: "mcp__plugin_serena_serena__activate_project" },
        { type: "tool_use", id: "read-call", name: "read" },
      ],
    }

    //#when
    const recovered = await recoverUnavailableTool(client as never, "session-1", failedAssistantMsg)

    //#then
    expect(recovered).toBe(true)
    expect(promptCalls).toEqual([
      {
        path: { id: "session-1" },
        body: {
          parts: [
            {
              type: "tool_result",
              tool_use_id: "alias-call",
              content: '{"status":"error","error":"Tool not available. Please continue without this tool."}',
            },
          ],
        },
      },
    ])
  })
})

import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "./fake-plugin-context"
import { installHooks } from "./install-hooks"

describe("V2 native tool definitions", () => {
  it("#when definition hooks run #then native definitions and request catalogs receive async edits until disposal", async () => {
    // given
    const fake = createFakePluginContext()
    await fake.context.tool.transform((editor) =>
      editor.add({
        name: "todowrite",
        description: "native todo",
        input: { type: "object" },
        execute: async () => ({ content: "done" }),
      }),
    )
    const seen: string[] = []
    const hooks: Hooks = {
      "tool.definition": async (input, output) => {
        await Promise.resolve()
        seen.push(input.toolID)
        output.description = `${input.toolID} updated`
        output.parameters = { type: "object", required: ["todos"] }
      },
    }
    // when
    const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
    try {
      expect(fake.addedTools.find((tool) => tool.name === "todowrite")?.description).toBe("todowrite updated")
      const tools = { late_mcp: { description: "dynamic", input: { type: "object" } } }
      await fake.triggerContext({
        sessionID: "s",
        agent: "a",
        model: { providerID: "p", id: "m" },
        system: [],
        messages: [],
        options: {},
        tools,
      })
      // then
      expect(tools.late_mcp).toEqual({
        description: "late_mcp updated",
        input: { type: "object", required: ["todos"] },
      })
      expect(seen).toEqual(["todowrite", "late_mcp"])
    } finally {
      await dispose()
    }
    expect(fake.addedTools.find((tool) => tool.name === "todowrite")?.description).toBe("native todo")
    expect(fake.sessionHookCount()).toBe(0)
  })
})

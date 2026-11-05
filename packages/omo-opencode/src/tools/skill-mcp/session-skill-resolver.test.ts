import { expect, spyOn, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { SkillMcpManager } from "../../features/skill-mcp-manager"
import { createSkillMcpTool } from "./tools"
import type { LoadedSkill } from "../../features/opencode-skill-loader"

const invocation: ToolContext = {
  sessionID: "ses_child", agent: "atlas", messageID: "msg_child", directory: "/test", worktree: "/test",
  abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
}
const declared: LoadedSkill = {
  name: "declared", scope: "config", definition: { name: "declared", template: "fixture" },
  mcpConfig: { server: { command: "must-not-run" } },
}

test("V2 MCP lookup rejects unaccepted skills even when the catalog declares their server", async () => {
  const manager = new SkillMcpManager()
  const call = spyOn(manager, "callTool").mockResolvedValue({ content: [] })
  const tool = createSkillMcpTool({
    manager, getLoadedSkills: () => [declared], getLoadedSkillsForSession: async () => [],
  })
  await expect(tool.execute({ mcp_name: "server", tool_name: "run" }, invocation)).rejects.toThrow("not found")
  expect(call).not.toHaveBeenCalled()
})

test("V2 MCP lookup uses the authentic target session and agent instead of a fallback parent identity", async () => {
  const manager = new SkillMcpManager()
  const call = spyOn(manager, "callTool").mockResolvedValue({ content: [] })
  const tool = createSkillMcpTool({
    manager, getLoadedSkills: () => [], getSessionID: () => "ses_parent",
    getLoadedSkillsForSession: async (context) => context.sessionID === "ses_child" && context.agent === "atlas" ? [{ skill: declared, revision: "accepted-source" }] : [],
  })
  await tool.execute({ mcp_name: "server", tool_name: "run" }, invocation)
  expect(call.mock.calls[0]?.[0].sessionID).toBe("ses_child")
  expect(call.mock.calls[0]?.[0].acceptedRevision).toBe("accepted-source")
})

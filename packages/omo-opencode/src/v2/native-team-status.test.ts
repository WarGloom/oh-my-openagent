import { expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { TeamModeConfigSchema } from "../config/schema/team-mode"
import { createTeamModeStatusInjector } from "../hooks/team-mode-status-injector/hook"
import { createMessagesTransformHandler } from "../plugin/messages-transform"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"

it("#given a team prompt on V2 #when the team ends #then one entry replaces bridge injection and is removed", async () => {
  // given
  const fake = createFakePluginContext()
  const calls: Array<{ action: string; sessionID: string; key: string; value?: string }> = []
  const context = { ...fake.context, session: { ...fake.context.session, instructions: { entry: {
    put: async (input: { sessionID: string; key: string; value: string }) => { calls.push({ action: "put", ...input }) },
    remove: async (input: { sessionID: string; key: string }) => { calls.push({ action: "remove", ...input }) },
  } } } }
  let active = true
  const hook = { ...createTeamModeStatusInjector(TeamModeConfigSchema.parse({ enabled: true })), nativeHasActiveTeam: async () => active }
  const transform = createMessagesTransformHandler({ hooks: { teamModeStatusInjector: hook } })
  const cleanup = await installSessionHooks(context, { "experimental.chat.messages.transform": transform } as Hooks, { warn: () => {} })
  try {
    // when
    await fake.triggerPrompt({ sessionID: "ses_1", messageID: "msg_1", prompt: { text: "team mode please" } })
    const event = await fake.triggerContext({ sessionID: "ses_1", agent: "sisyphus", model: { providerID: "openai", id: "gpt-test" }, system: [], messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "team mode please" }] }], options: {} })
    const deletion = { tool: "team_delete", sessionID: "ses_1", agent: "sisyphus", messageID: "msg_1", id: "call_1", input: {}, status: "completed" as const, result: {} }
    await fake.triggerToolAfter(deletion)
    expect(calls).toHaveLength(1)
    active = false
    await fake.triggerToolAfter(deletion)

    // then
    expect(event.messages).toHaveLength(1)
    expect(calls.map(({ action, sessionID, key }) => ({ action, sessionID, key }))).toEqual([
      { action: "put", sessionID: "ses_1", key: "omo.team-status" },
      { action: "remove", sessionID: "ses_1", key: "omo.team-status" },
    ])
    expect(calls[0]?.value).toContain("<team_mode_status")
  } finally {
    await cleanup()
  }
})

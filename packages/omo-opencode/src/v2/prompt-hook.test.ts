import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"

describe("V2 prompt selections", () => {
  it("#when chat.message changes model, variant and agent #then native execution uses them and restores the temporary model", async () => {
    // given
    const previous = { providerID: "openai", id: "gpt-5", variant: "medium" }
    const selected = { providerID: "anthropic", id: "claude-opus-4", variant: "high" }
    const fake = createFakePluginContext({ sessionAgent: "Sisyphus", sessionInfo: { model: previous } })
    const hooks: Hooks = {
      "chat.message": async (input, output) => {
        expect(input.model).toEqual({ providerID: "openai", modelID: "gpt-5" })
        expect(output.message.variant).toBe("medium")
        expect(output.message.agent).toBe("Sisyphus")
        output.message.model = { providerID: selected.providerID, modelID: selected.id }
        output.message.variant = selected.variant
        output.message.agent = "Atlas"
      },
    }
    const dispose = await installSessionHooks(fake.context, hooks, { warn: () => {} })
    try {
      // when
      await fake.triggerPrompt({ sessionID: "ses_1", messageID: "msg_1", prompt: { text: "think" } })
      expect((await fake.context.session.get({ sessionID: "ses_1" })).model?.variant).toBe("high")
      expect(fake.sessionCalls).toContainEqual({ kind: "switchModel", sessionID: "ses_1", model: selected })
      expect(fake.sessionCalls).toContainEqual({ kind: "switchAgent", sessionID: "ses_1", agent: "Atlas" })
      await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
      // then
      expect(fake.sessionCalls.at(-1)).toEqual({ kind: "switchModel", sessionID: "ses_1", model: previous })
    } finally {
      await dispose()
    }
  })

  it("#when a fallback changes the model before idle #then restoration preserves the fallback model", async () => {
    // given
    const fake = createFakePluginContext({ sessionInfo: { model: { providerID: "openai", id: "gpt-5" } } })
    const hooks: Hooks = {
      "chat.message": async (_input, output) => {
        output.message.variant = "high"
      },
    }
    const dispose = await installSessionHooks(fake.context, hooks, { warn: () => {} })
    try {
      await fake.triggerPrompt({ sessionID: "ses_1", messageID: "msg_1", prompt: { text: "think" } })
      // when
      const fallback = { providerID: "anthropic", id: "claude-sonnet-4" }
      await fake.context.session.switchModel({ sessionID: "ses_1", model: fallback })
      await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
      // then
      expect((await fake.context.session.get({ sessionID: "ses_1" })).model).toEqual(fallback)
    } finally {
      await dispose()
    }
  })
})

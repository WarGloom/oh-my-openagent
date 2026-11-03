import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "./fake-plugin-context"
import type { V2ModelInfo, V2ToolBeforeEvent } from "./context-types"
import { bindAgentModelOverrides } from "./native-subagent-model"
import { installHooks } from "./install-hooks"

const primary = "anthropic/claude-haiku-5-5"
const agent = "pinion-rust-dev-light"
const hostModel: V2ModelInfo = {
  id: "haiku",
  modelID: "claude-haiku-5-5",
  providerID: "anthropic",
  name: "Haiku",
  status: "active",
  enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "xhigh" }],
  limit: { context: 200_000, output: 8_000 },
}

describe("V2 native subagent OMO model overrides", () => {
  test.each([
    {
      name: "supported reasoning",
      settings: { reasoning: "xhigh" },
      variants: [{ id: "xhigh" }],
      model: `${primary}#xhigh`,
    },
    {
      name: "supported custom variant",
      settings: { variant: "host-custom" },
      variants: [{ id: "host-custom" }],
      model: `${primary}#host-custom`,
    },
    { name: "unsupported reasoning", settings: { reasoning: "xhigh" }, variants: [{ id: "low" }], model: primary },
  ])(
    "injects the configured primary for $name before the host creates a new child",
    async ({ settings, variants, model }) => {
      // given
      const fake = createFakePluginContext({ models: [{ ...hostModel, variants }] })
      const hooks: Hooks = {}
      bindAgentModelOverrides(hooks, {
        [agent]: {
          model: primary,
          ...settings,
          fallback_models: ["openai/gpt-6-luna", "github-copilot/claude-haiku-4.5"],
        },
      })
      const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
      const event: V2ToolBeforeEvent = {
        tool: "subagent",
        sessionID: "ses_parent",
        agent: "coordinator",
        messageID: "msg_1",
        id: "call_1",
        input: { agent, background: true, prompt: "work" },
      }

      // when
      await fake.triggerToolBefore(event)

      // then
      expect(event.input).toEqual({ agent, background: true, prompt: "work", model })
      await dispose()
      const unloaded = { ...event, input: { agent, prompt: "after unload" } }
      await fake.triggerToolBefore(unloaded)
      expect(unloaded.input).toEqual({ agent, prompt: "after unload" })
    },
  )

  test.each([
    { name: "explicit model", tool: "subagent", input: { agent, model: "openai/gpt-6-luna#high" } },
    { name: "session follow-up", tool: "subagent", input: { agent, sessionID: "ses_child" } },
    { name: "no override", tool: "subagent", input: { agent: "unconfigured" } },
    { name: "override without model", tool: "subagent", input: { agent: "reasoning-only" } },
    { name: "non-subagent tool", tool: "other", input: { agent } },
  ])("preserves $name", async ({ tool, input }) => {
    // given
    const fake = createFakePluginContext({ models: [hostModel] })
    const hooks: Hooks = {}
    bindAgentModelOverrides(hooks, {
      [agent]: { model: primary, reasoning: "xhigh" },
      "reasoning-only": { reasoning: "high" },
    })
    const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
    const event: V2ToolBeforeEvent = {
      tool,
      sessionID: "ses_parent",
      agent: "coordinator",
      messageID: "msg_1",
      id: "call_1",
      input,
    }
    const expected = structuredClone(input)

    // when
    await fake.triggerToolBefore(event)

    // then
    expect(event.input).toEqual(expected)
    await dispose()
  })
})

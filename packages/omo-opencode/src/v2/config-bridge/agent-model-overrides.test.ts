import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "../fake-plugin-context"
import type { V2AgentInfo, V2ModelInfo } from "../context-types"
import { bindAgentModelOverrides } from "./desired-config"
import { installHooks } from "../install-hooks"

const primary = "anthropic/claude-haiku-5-5"
const userAgent: V2AgentInfo = {
  id: "pinion-rust-dev-light",
  name: "pinion-rust-dev-light",
  model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
  mode: "subagent",
  hidden: false,
  permissions: [],
}
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

describe("V2 host agent OMO model overrides", () => {
  test.each([
    { settings: { reasoning: "xhigh" }, variants: [{ id: "xhigh" }], variant: "xhigh" },
    { settings: { variant: "host-custom" }, variants: [{ id: "host-custom" }], variant: "host-custom" },
    { settings: { reasoning: "xhigh" }, variants: [{ id: "low" }], variant: undefined },
  ])(
    "applies a materialized models primary with only supported variants: $variant",
    async ({ settings, variants, variant }) => {
      // given
      const control = { ...userAgent, id: "unconfigured", name: "unconfigured" }
      const fake = createFakePluginContext({ agents: [userAgent, control], models: [{ ...hostModel, variants }] })
      const hooks: Hooks = { config: async () => {} }
      bindAgentModelOverrides(hooks, {
        [userAgent.id]: {
          model: primary,
          ...settings,
          fallback_models: ["openai/gpt-6-luna", "github-copilot/claude-haiku-4.5"],
        },
      })

      // when
      const dispose = await installHooks(fake.context, hooks, { warn: () => {} })

      // then
      expect(fake.builtAgents().get(userAgent.id)?.model).toEqual({
        providerID: "anthropic",
        id: "claude-haiku-5-5",
        ...(variant ? { variant } : {}),
      })
      expect(fake.builtAgents().get(control.id)?.model).toEqual(control.model)
      await dispose()
      expect(fake.builtAgents().get(userAgent.id)?.model).toEqual(userAgent.model)
    },
  )
})

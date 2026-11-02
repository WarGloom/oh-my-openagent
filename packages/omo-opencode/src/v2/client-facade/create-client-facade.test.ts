import { describe, expect, it } from "bun:test"
import type { V2AgentInfo, V2ModelInfo, V2ProviderInfo } from "../context-types"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { V2UnsupportedOperationError } from "../unsupported-operation-error"
import { createClientFacade } from "./create-client-facade"
import { buildTuiRuntimeSnapshot } from "../../features/tui-sidebar/snapshot-builder"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"

const facadeDeps = () => ({ tracker: createSessionTracker(), warn: () => {} })

function model(overrides: Partial<V2ModelInfo> & Pick<V2ModelInfo, "providerID" | "modelID">): V2ModelInfo {
  return {
    id: overrides.modelID,
    name: overrides.modelID,
    status: "active",
    enabled: true,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    limit: { context: 200_000, output: 8_000 },
    ...overrides,
  }
}

const providers: V2ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", activation: "enabled" },
  { id: "openai", name: "OpenAI", activation: "auto" },
]

function agent(overrides: Partial<V2AgentInfo> & Pick<V2AgentInfo, "id">): V2AgentInfo {
  return { name: overrides.id, mode: "primary", hidden: false, permissions: [], ...overrides }
}

describe("createClientFacade", () => {
  it("#given team mode and a V2 session #when building a mirror snapshot #then the facade provides the session list", async () => {
    // given
    const fake = createFakePluginContext({ directory: "/work/app" })
    const info = await fake.context.session.get({ sessionID: "ses_lead" })
    const context = {
      ...fake.context,
      session: { ...fake.context.session, list: async () => ({ data: [info], cursor: {} }) },
    }
    const client = createClientFacade(context, facadeDeps())
    const seen: string[] = []

    // when
    const snapshot = await buildTuiRuntimeSnapshot({
      client,
      projectDir: "/work/app",
      teamModeConfig: TeamModeConfigSchema.parse({ enabled: true }),
      teamRuntimeProvider: {
        listActiveTeams: async () => {
          seen.push("teams")
          return []
        },
        loadRuntimeState: async () => {
          throw new Error("unexpected runtime")
        },
        listTasks: async () => [],
      },
    })

    // then
    expect(snapshot.teams).toEqual([])
    expect(seen).toEqual(["teams"])
  })

  describe("#given provider.list", () => {
    it("#when called #then connected providers are those with at least one enabled model", async () => {
      // given
      const { context } = createFakePluginContext({
        providers,
        models: [
          model({ providerID: "anthropic", modelID: "claude-opus" }),
          model({ providerID: "openai", modelID: "gpt-x", enabled: false }),
        ],
      })

      // when
      const result = await createClientFacade(context, facadeDeps()).provider.list()

      // then
      expect(result.data?.connected).toEqual(["anthropic"])
      expect(result.data?.all.map((provider) => provider.id)).toEqual(["anthropic", "openai"])
    })

    it("#when called #then each provider carries its models keyed by model id in the 1.x metadata shape", async () => {
      // given
      const { context } = createFakePluginContext({
        providers,
        models: [
          model({
            providerID: "anthropic",
            modelID: "claude-opus",
            name: "Claude Opus",
            variants: [{ id: "high" }],
            limit: { context: 1_000_000, output: 64_000 },
          }),
        ],
      })

      // when
      const result = await createClientFacade(context, facadeDeps()).provider.list()

      // then
      const anthropic = result.data?.all.find((provider) => provider.id === "anthropic")
      expect(anthropic?.models["claude-opus"]).toMatchObject({
        id: "claude-opus",
        providerID: "anthropic",
        name: "Claude Opus",
        tool_call: true,
        reasoning: true,
        attachment: true,
        limit: { context: 1_000_000, output: 64_000 },
        status: "active",
      })
    })

    it("#when the default model is known #then it is reported as that provider's default", async () => {
      // given
      const opus = model({ providerID: "anthropic", modelID: "claude-opus" })
      const { context } = createFakePluginContext({ providers, models: [opus], defaultModel: opus })

      // when
      const result = await createClientFacade(context, facadeDeps()).provider.list()

      // then
      expect(result.data?.default).toEqual({ anthropic: "claude-opus" })
    })
  })

  describe("#given config.get", () => {
    it("#when the host has a default model #then the config names it as provider/model", async () => {
      // given
      const opus = model({ providerID: "anthropic", modelID: "claude-opus" })
      const { context } = createFakePluginContext({ models: [opus], defaultModel: opus })

      // when
      const result = await createClientFacade(context, facadeDeps()).config.get()

      // then
      expect(result.data).toMatchObject({ model: "anthropic/claude-opus" })
    })

    it("#when the host has no default model #then the config has no model key", async () => {
      // given
      const { context } = createFakePluginContext()

      // when
      const result = await createClientFacade(context, facadeDeps()).config.get()

      // then
      expect(result.data && "model" in result.data).toBe(false)
    })
  })

  describe("#given app.agents", () => {
    it("#when called #then host agents come back in the 1.x agent shape", async () => {
      // given
      const { context } = createFakePluginContext({
        agents: [
          agent({ id: "build", description: "Builds", mode: "primary", color: "#112233" }),
          agent({ id: "explore", mode: "subagent", hidden: true, model: { providerID: "openai", id: "gpt-x" } }),
        ],
      })

      // when
      const result = await createClientFacade(context, facadeDeps()).app.agents()

      // then
      expect(result.data).toMatchObject([
        { name: "build", description: "Builds", mode: "primary", color: "#112233", hidden: false },
        { name: "explore", mode: "subagent", hidden: true, model: { providerID: "openai", modelID: "gpt-x" } },
      ])
    })

    it("#when an agent has 2.x permission rules #then they come back as 1.x rules in order with 1.x permission keys", async () => {
      // given
      const { context } = createFakePluginContext({
        agents: [
          agent({
            id: "pinion-rust-dev",
            mode: "subagent",
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              { action: "team_send_message", resource: "*", effect: "allow" },
              { action: "subagent", resource: "*", effect: "deny" },
              { action: "shell", resource: "git *", effect: "ask" },
            ],
          }),
        ],
      })

      // when
      const result = await createClientFacade(context, facadeDeps()).app.agents()

      // then
      expect(result.data[0]?.permission).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "team_send_message", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "git *", action: "ask" },
      ])
    })
  })

  describe("#given a V1 client method with no 2.x mapping", () => {
    it("#when it lives in an unmapped namespace #then it rejects naming the exact call", async () => {
      // given
      const { context } = createFakePluginContext()
      const client = createClientFacade(context, facadeDeps())

      // when
      const call = client.session.children({ path: { id: "ses_1" } })

      // then
      await expect(call).rejects.toBeInstanceOf(V2UnsupportedOperationError)
      await expect(call).rejects.toMatchObject({ operation: "client.session.children" })
    })

    it("#when it lives in a mapped namespace #then it still rejects naming the exact call", async () => {
      // given
      const { context } = createFakePluginContext()
      const client = createClientFacade(context, facadeDeps())

      // when
      const call = client.provider.auth()

      // then
      await expect(call).rejects.toMatchObject({ operation: "client.provider.auth" })
    })

    it("#when the client is awaited directly #then it is not mistaken for a thenable", async () => {
      // given
      const { context } = createFakePluginContext()
      const client = createClientFacade(context, facadeDeps())

      // when
      const resolved = await Promise.resolve(client)

      // then
      expect(resolved).toBe(client)
    })
  })
})

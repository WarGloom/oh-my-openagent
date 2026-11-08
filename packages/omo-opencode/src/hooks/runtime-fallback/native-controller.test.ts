import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { OhMyOpenCodeConfig } from "../../config"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { DEFAULT_CONFIG } from "./constants"
import { createNativeFallbackController } from "./native-controller"
import type { HookDeps } from "./types"

const primary = "anthropic/claude-haiku-5-5"
const luna = "openai/gpt-6-luna"
const copilot = "github-copilot/claude-haiku-4.5"
const agent = "pinion-rust-dev-light"
const chain = {
  model: primary,
  reasoning: "xhigh",
  fallback_models: [luna, copilot, copilot],
} as const

function fixture(pluginConfig: OhMyOpenCodeConfig) {
  const deps: HookDeps = {
    ctx: {
      directory: "/test",
      client: {
        session: { abort: async () => {}, messages: async () => [], promptAsync: async () => {} },
        tui: { showToast: async () => {} },
      },
    },
    config: { ...DEFAULT_CONFIG, enabled: true, max_fallback_attempts: 10 },
    options: undefined,
    pluginConfig,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackAbortInFlight: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionFallbackHardTimeouts: new Map(),
    sessionFallbackTimeoutAgents: new Map(),
    sessionFallbackTimeoutKinds: new Map(),
    sessionFallbackProgressObserved: new Set(),
    sessionFallbackUnsafeToReplay: new Set(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
  const controller = createNativeFallbackController(deps)
  const selected: string[] = []
  const recover = (model: string, error: unknown = { status: 429 }) =>
    controller.recover({ sessionID: "ses_child", agent, model, error }, async (payload) => {
      selected.push(`${payload.model.providerID}/${payload.model.modelID}`)
    })
  return { controller, recover, selected }
}

afterEach(() => SessionCategoryRegistry.clear())

describe("native controller configured primary recovery", () => {
  test("preserves provider reset deadlines after a manual model switch", async () => {
    using clock = spyOn(Date, "now").mockReturnValue(1_000)
    const f = fixture({ agents: { [agent]: { ...chain, fallback_models: [...chain.fallback_models] } } })
    await f.recover(primary, { status: 429, retryAfterMs: 86_400_000 })
    await f.controller.restorePrimary({ sessionID: "ses_child", agent, model: copilot }, async () => {})
    const recovered = await f.recover(copilot)
    f.controller.forget("ses_child")
    expect(recovered).toBe(true)
    expect(f.selected).toEqual([luna, luna])
  })
  test.each(["agent", "session-category", "agent-category", "agent-primary-category-fallbacks"] as const)(
    "recovers an untried %s primary before remaining fallbacks",
    async (source) => {
      // given
      using clock = spyOn(Date, "now").mockReturnValue(1_000)
      const config: OhMyOpenCodeConfig =
        source === "agent"
          ? { agents: { [agent]: { ...chain, fallback_models: [...chain.fallback_models] } } }
          : source === "agent-primary-category-fallbacks"
            ? {
                agents: { [agent]: { model: primary, category: "quick" } },
                categories: { quick: { fallback_models: [...chain.fallback_models] } },
              }
            : {
                agents: { [agent]: { category: "quick" } },
                categories: { quick: { ...chain, fallback_models: [...chain.fallback_models] } },
              }
      if (source === "session-category") SessionCategoryRegistry.register("ses_child", "quick")
      const f = fixture(config)

      // when
      const recovered = await f.recover(luna)
      expect(f.selected).toEqual([primary])
      const continued = await f.recover(primary)
      const exhausted = await f.recover(copilot)

      // then
      expect([recovered, continued, exhausted]).toEqual([true, true, false])
      expect(f.selected).toEqual([primary, copilot])
      f.controller.forget("ses_child")
    },
  )

  test("preserves fallback order when the session starts on its configured primary", async () => {
    // given
    using clock = spyOn(Date, "now").mockReturnValue(1_000)
    const f = fixture({ agents: { [agent]: { ...chain, fallback_models: [...chain.fallback_models] } } })

    // when
    const recovered = await f.recover(primary)
    const continued = await f.recover(luna)
    const exhausted = await f.recover(copilot)

    // then
    expect([recovered, continued, exhausted]).toEqual([true, true, false])
    expect(f.selected).toEqual([luna, copilot])
    f.controller.forget("ses_child")
  })
})

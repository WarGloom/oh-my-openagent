import { describe, expect, test } from "bun:test"

import { createChatMessageHandler } from "./chat-message-handler"
import { createFallbackState } from "./fallback-state"
import { hasRuntimeFallbackModelOverride } from "../../shared/runtime-fallback-model-override-marker"
import { clearSessionModel, getSessionModel } from "../../shared/session-model-state"
import type { FallbackState, HookDeps } from "./types"

function buildDeps(
  sessionStates: Map<string, FallbackState> = new Map(),
  configOverrides: Partial<HookDeps["config"]> = {},
): HookDeps {
  const config: HookDeps["config"] = {
    enabled: true,
    retry_on_errors: [429, 500, 502, 503, 504],
    cooldown_seconds: 60,
    max_fallback_attempts: 5,
    timeout_seconds: 300,
    first_progress_timeout_seconds: 300,
    stall_timeout_seconds: 600,
    hard_timeout_seconds: 1800,
    notify_on_fallback: true,
    restore_primary_after_cooldown: false,
    ...configOverrides,
  }

  return {
    ctx: {
      client: {
        session: {} as never,
        tui: {} as never,
      },
      directory: "/tmp",
    },
    config,
    options: undefined,
    pluginConfig: undefined,
    sessionStates,
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
}

function createDeps(): HookDeps {
  return buildDeps(new Map(), {
    retry_on_errors: [429, 503, 529],
    max_fallback_attempts: 3,
    cooldown_seconds: 0,
    timeout_seconds: 30,
    first_progress_timeout_seconds: 30,
  })
}

function buildState(currentModel: string, pending?: string): FallbackState {
  const state = createFallbackState("openai/gpt-5.5(xhigh)")
  state.currentModel = currentModel
  state.fallbackIndex = 2
  state.attemptCount = 3
  if (pending) state.pendingFallbackModel = pending
  return state
}

describe("chat-message-handler variant suffix loop regression", () => {
  test("variant-only echo of pending fallback does not reset attemptCount", async () => {
    const sessionID = "ses_test_variant_echo"
    const state = buildState(
      "github-copilot/claude-opus-4.6(max)",
      "github-copilot/claude-opus-4.6(max)",
    )
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))

    await handler(
      {
        sessionID,
        model: { providerID: "github-copilot", modelID: "claude-opus-4.6" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(3)
    expect(after.fallbackIndex).toBe(2)
    expect(after.currentModel).toBe("github-copilot/claude-opus-4.6(max)")
    expect(after.pendingFallbackModel).toBeUndefined()
  })

  test("variant-only echo without pending marker preserves state", async () => {
    const sessionID = "ses_test_variant_no_pending"
    const state = buildState("github-copilot/claude-opus-4.6(max)")
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))

    await handler(
      {
        sessionID,
        model: { providerID: "github-copilot", modelID: "claude-opus-4.6" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(3)
    expect(after.fallbackIndex).toBe(2)
    expect(after.currentModel).toBe("github-copilot/claude-opus-4.6(max)")
  })

  test("genuine manual model change still resets fallback state", async () => {
    const sessionID = "ses_test_manual_change"
    const state = buildState("github-copilot/claude-opus-4.6(max)")
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))

    await handler(
      {
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(0)
    expect(after.fallbackIndex).toBe(-1)
    expect(after.currentModel).toBe("anthropic/claude-sonnet-4-6")
    expect(after.originalModel).toBe("anthropic/claude-sonnet-4-6")
  })

  test("manual model change clears stale fallback bookkeeping", async () => {
    const sessionID = "ses_test_manual_change_clears_fallback_bookkeeping"
    const state = createFallbackState("anthropic/claude-opus-4-8(max)")
    state.currentModel = "opencode/qwen3.6-plus-free(high)"
    state.fallbackIndex = 1
    state.attemptCount = 2
    state.pendingFallbackModel = "github-copilot/claude-opus-4.8(max)"
    state.pendingFallbackPromptMayHaveBeenAccepted = true
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const deps = buildDeps(sessionStates)
    const fallbackTimeout = setTimeout(() => undefined, 1_000)
    const hardTimeout = setTimeout(() => undefined, 1_000)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionFallbackAbortInFlight.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, fallbackTimeout)
    deps.sessionFallbackHardTimeouts.set(sessionID, hardTimeout)
    deps.sessionFallbackTimeoutAgents.set(sessionID, "sisyphus")
    deps.sessionFallbackTimeoutKinds.set(sessionID, "stall")
    deps.sessionFallbackProgressObserved.add(sessionID)
    deps.sessionFallbackUnsafeToReplay.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "1:retry")
    const handler = createChatMessageHandler(deps)

    await handler(
      {
        sessionID,
        model: { providerID: "openai", modelID: "gpt-5.5" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(0)
    expect(after.fallbackIndex).toBe(-1)
    expect(after.currentModel).toBe("openai/gpt-5.5")
    expect(after.originalModel).toBe("openai/gpt-5.5")
    expect(after.pendingFallbackModel).toBeUndefined()
    expect(after.pendingFallbackPromptMayHaveBeenAccepted).toBeUndefined()
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackHardTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeoutAgents.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeoutKinds.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackProgressObserved.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackUnsafeToReplay.has(sessionID)).toBe(false)
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
  })

  test("original model echo during active fallback preserves fallback state", async () => {
    const sessionID = "ses_test_original_echo_active_fallback"
    const state = createFallbackState("anthropic/claude-sonnet-4-6")
    state.currentModel = "github-copilot/claude-sonnet-4.6"
    state.fallbackIndex = 0
    state.attemptCount = 1

    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const deps = buildDeps(sessionStates)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, {})
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string; variant?: string } } } = {
      message: {},
    }

    await handler(
      {
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      output,
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(1)
    expect(after.fallbackIndex).toBe(0)
    expect(after.originalModel).toBe("anthropic/claude-sonnet-4-6")
    expect(after.currentModel).toBe("github-copilot/claude-sonnet-4.6")
    expect(output.message.model).toEqual({
      providerID: "github-copilot",
      modelID: "claude-sonnet-4.6",
    })
  })

  test("manual switch back to original model resets after fallback result is no longer pending", async () => {
    const sessionID = "ses_test_original_manual_reset"
    const state = createFallbackState("anthropic/claude-sonnet-4-6")
    state.currentModel = "github-copilot/claude-sonnet-4.6"
    state.fallbackIndex = 0
    state.attemptCount = 1

    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))

    await handler(
      {
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(0)
    expect(after.fallbackIndex).toBe(-1)
    expect(after.originalModel).toBe("anthropic/claude-sonnet-4-6")
    expect(after.currentModel).toBe("anthropic/claude-sonnet-4-6")
  })

  test("object-shaped stored model is normalized before identity comparison", async () => {
    const sessionID = "ses_test_object_state_model"
    const state = buildState("openai/gpt-5.5")
    Object.assign(state, {
      currentModel: { providerID: "github-copilot", modelID: "claude-opus-4.6(max)" },
      originalModel: { providerID: "github-copilot", modelID: "claude-opus-4.6(max)" },
      pendingFallbackModel: { providerID: "github-copilot", modelID: "claude-opus-4.6(max)" },
    })
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))

    await handler(
      {
        sessionID,
        model: { providerID: "github-copilot", modelID: "claude-opus-4.6" },
      },
      { message: {} },
    )

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(3)
    expect(after.fallbackIndex).toBe(2)
    expect(after.pendingFallbackModel).toBeUndefined()
  })

  test("fallback override sends variant outside modelID", async () => {
    const sessionID = "ses_test_variant_payload"
    clearSessionModel(sessionID)
    const state = buildState("anthropic/claude-opus-4-7(max)")
    const sessionStates = new Map<string, FallbackState>([[sessionID, state]])
    const handler = createChatMessageHandler(buildDeps(sessionStates))
    const output: { message: { model?: { providerID: string; modelID: string; variant?: string } } } = {
      message: {},
    }

    await handler(
      {
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      },
      output,
    )

    expect(output.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
      variant: "max",
    })
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
    })
    expect(hasRuntimeFallbackModelOverride(output.message)).toBe(true)

    const after = sessionStates.get(sessionID)!
    expect(after.attemptCount).toBe(3)
    expect(after.fallbackIndex).toBe(2)
    expect(after.currentModel).toBe("anthropic/claude-opus-4-7(max)")
    clearSessionModel(sessionID)
  })
})

describe("createChatMessageHandler runtime fallback model override", () => {
  test("#given retained retry status keys #when the user selects another model #then the reset starts a fresh retry generation", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-manual-model-reset"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "google/gemini-2.5-pro"
    deps.sessionStates.set(sessionID, state)
    deps.sessionStatusRetryKeys.set(sessionID, new Set(["openai/gpt-5.4:1:quota exceeded"]))
    const handler = createChatMessageHandler(deps)

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      { message: {} },
    )

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("anthropic/claude-opus-4-7")
  })

  test("#given retained variant retry keys #when the user changes only the variant #then the reset starts a fresh retry generation", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-manual-variant-reset"
    const state = createFallbackState({
      providerID: "openai",
      modelID: "gpt-5.4",
      variant: "high",
    })
    deps.sessionStates.set(sessionID, state)
    deps.sessionStatusRetryKeys.set(sessionID, new Set(["openai/gpt-5.4(low):1:quota exceeded"]))
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const fallbackTimeout = setTimeout(() => {}, 60_000)
    fallbackTimeout.unref()
    deps.sessionFallbackTimeouts.set(sessionID, fallbackTimeout)
    const handler = createChatMessageHandler(deps)

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      { message: { variant: "low" } },
    )

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("openai/gpt-5.4(low)")
  })

  test("#given session is on an accepted fallback #when a later user message is transformed after cooldown #then it stays on the fallback model", async () => {
    const deps = createDeps()
    const sessionID = "session-active-fallback"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "litellm/openai.eu.gpt-5.5"
    state.fallbackIndex = 0
    state.failedModels.set("openai/gpt-5.4", Date.now() - 60_000)
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string } } } = { message: {} }

    await handler(
      {
        sessionID,
        model: {
          providerID: "litellm",
          modelID: "openai.eu.gpt-5.5",
        },
      },
      output,
    )

    expect(output.message.model).toEqual({
      providerID: "litellm",
      modelID: "openai.eu.gpt-5.5",
    })
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("litellm/openai.eu.gpt-5.5")
  })

  test("#given an accepted variant fallback #when the fallback override is reapplied #then model and variant remain separate", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-active-variant-fallback"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    })
  })

  test("#given an explicit-variant fallback and a base primary #when cooldown restoration runs #then the fallback-only variant is removed", async () => {
    // given
    const deps = createDeps()
    deps.config.restore_primary_after_cooldown = true
    const sessionID = "session-clear-fallback-only-variant"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "anthropic/claude-opus-4-7(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    })
  })

  test("#given an inherited primary variant #when cooldown restoration runs #then the inherited variant remains applied", async () => {
    // given
    const deps = createDeps()
    deps.config.restore_primary_after_cooldown = true
    deps.pluginConfig = {
      agents: {
        sisyphus: {
          variant: "high",
        },
      },
    }
    const sessionID = "session-restore-inherited-primary-variant"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "anthropic/claude-opus-4-7(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        agent: "sisyphus",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    })
  })
})

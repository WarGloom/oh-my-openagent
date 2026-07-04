/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"

function createContext(toastMessages: string[] = []): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async (input) => {
          toastMessages.push(input.body.message)
          return {}
        },
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(toastMessages: string[] = []): HookDeps {
  return {
    ctx: createContext(toastMessages),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 1,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      first_progress_timeout_seconds: 30,
      stall_timeout_seconds: 600,
      hard_timeout_seconds: 1800,
      notify_on_fallback: false,
      restore_primary_after_cooldown: false,
    },
    options: undefined,
    pluginConfig: undefined,
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
}

function createHelpers(
  abortCalls: Array<{ sessionID: string; source: string }>,
  retryCalls: Array<{ sessionID: string; model: string; source: string }> = [],
  clearCalls: string[] = [],
): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string, source: string) => {
      abortCalls.push({ sessionID, source })
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
    },
    clearSessionFallbackState: (sessionID: string) => {
      clearCalls.push(sessionID)
    },
    scheduleSessionFallbackTimeout: () => {},
    refreshSessionFallbackTimeout: () => false,
    autoRetryWithFallback: async (
      sessionID: string,
      model: string,
      _resolvedAgent: string | undefined,
      source: string,
    ) => {
      retryCalls.push({ sessionID, model, source })
      return { accepted: true, status: "dispatched" }
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

function createRejectedDispatchHelpers(dispatchCalls: string[]): AutoRetryHelpers {
  const helpers = createHelpers([])
  helpers.autoRetryWithFallback = (async (_sessionID, model) => {
    dispatchCalls.push(model)
    return { accepted: false, status: "blocked", reason: "test gate blocked dispatch" }
  }) as AutoRetryHelpers["autoRetryWithFallback"]
  return helpers
}

describe("dispatchFallbackRetry", () => {
  it("#given fallback attempts are exhausted #when dispatchFallbackRetry runs #then it aborts the session and clears runtime-fallback state", async () => {
    // given
    const deps = createDeps()
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const helpers = createHelpers(abortCalls)
    const sessionID = "fallback-dispatch-max-attempts"
    const state = createFallbackState("openai/gpt-5.5")
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackAbortInFlight.add(sessionID)

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.4"],
      resolvedAgent: "test-agent",
      source: "session.status",
    })

    // then
    expect(abortCalls).toEqual([{ sessionID, source: "runtime-fallback:max-attempts" }])
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given tool progress happened in the current turn #when fallback retry dispatches #then it suppresses automatic prompt replay", async () => {
    // given
    const deps = createDeps()
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const clearCalls: string[] = []
    const helpers = createHelpers(abortCalls, retryCalls, clearCalls)
    const sessionID = "fallback-dispatch-tool-progress"
    const state = createFallbackState("openai/gpt-5.5")
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackAbortInFlight.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    deps.sessionFallbackUnsafeToReplay.add(sessionID)

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.4"],
      resolvedAgent: "test-agent",
      source: "session.error",
    })

    // then
    expect(retryCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(clearCalls).toEqual([sessionID])
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(state.attemptCount).toBe(0)
    expect(state.currentModel).toBe("openai/gpt-5.5")
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given fallback dispatch is blocked #when fallback retry runs #then state is restored and no success toast is shown", async () => {
    // given
    const toastMessages: string[] = []
    const dispatchCalls: string[] = []
    const deps = createDeps(toastMessages)
    deps.config.notify_on_fallback = true
    const helpers = createRejectedDispatchHelpers(dispatchCalls)
    const sessionID = "session-dispatch-rejected"
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["litellm/openai.eu.gpt-5.5"],
      source: "message.updated",
    })

    // then
    expect(dispatchCalls).toEqual(["litellm/openai.eu.gpt-5.5"])
    expect(toastMessages).toEqual([])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    expect(state.failedModels.size).toBe(0)
  })

  it("#given first fallback prompt is not accepted #when dispatchFallbackRetry runs #then fallback state is restored exactly", async () => {
    // given
    const deps = createDeps()
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const sessionID = "fallback-dispatch-not-accepted"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(abortCalls)
    helpers.autoRetryWithFallback = async (_sessionID, _model, _resolvedAgent, _source, callbacks) => {
      callbacks?.onPromptNotAccepted?.()
      return { accepted: false, status: "blocked", reason: "test gate blocked dispatch" }
    }

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.4"],
      resolvedAgent: "test-agent",
      source: "session.error",
    })

    // then
    expect(state.originalModel).toBe("anthropic/claude-opus-4-7")
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBeUndefined()
    expect([...state.failedModels.entries()]).toEqual([])
  })

  it("#given previous pending fallback exists #when second deferred fallback is not accepted #then previous pending fallback is preserved", async () => {
    // given
    const deps = createDeps()
    deps.config.max_fallback_attempts = 3
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const sessionID = "fallback-dispatch-preserve-pending"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.pendingFallbackPromptMayHaveBeenAccepted = true
    state.failedModels.set("anthropic/claude-opus-4-7", 12345)
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(abortCalls)
    helpers.autoRetryWithFallback = async (_sessionID, _model, _resolvedAgent, _source, callbacks) => {
      callbacks?.onPromptNotAccepted?.()
      return { accepted: false, status: "blocked", reason: "test gate blocked dispatch" }
    }

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
      resolvedAgent: "test-agent",
      source: "session.error",
    })

    // then
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.fallbackIndex).toBe(0)
    expect(state.attemptCount).toBe(1)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(true)
    expect([...state.failedModels.entries()]).toEqual([["anthropic/claude-opus-4-7", 12345]])
  })

  it("#given fallback notification is enabled #when retry prompt is not accepted #then it does not announce switching models", async () => {
    // given
    const toastMessages: string[] = []
    const deps = createDeps(toastMessages)
    deps.config.notify_on_fallback = true
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const sessionID = "fallback-dispatch-toast-not-accepted"
    const state = createFallbackState("anthropic/claude-fable-5")
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(abortCalls)
    helpers.autoRetryWithFallback = async (_sessionID, _model, _resolvedAgent, _source, callbacks) => {
      callbacks?.onPromptNotAccepted?.()
      return { accepted: false, status: "blocked", reason: "test gate blocked dispatch" }
    }

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.5"],
      resolvedAgent: "test-agent",
      source: "session.status",
    })

    // then
    expect(toastMessages).toEqual([])
    expect(state.currentModel).toBe("anthropic/claude-fable-5")
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given fallback notification is enabled #when retry prompt is accepted #then it announces the accepted fallback model once", async () => {
    // given
    const toastMessages: string[] = []
    const deps = createDeps(toastMessages)
    deps.config.notify_on_fallback = true
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const sessionID = "fallback-dispatch-toast-accepted"
    const state = createFallbackState("anthropic/claude-fable-5")
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(abortCalls)
    helpers.autoRetryWithFallback = async (_sessionID, _model, _resolvedAgent, _source, callbacks) => {
      await callbacks?.onPromptAccepted?.()
      return { accepted: true, status: "dispatched" }
    }

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.5"],
      resolvedAgent: "test-agent",
      source: "session.status",
    })

    // then
    expect(toastMessages).toHaveLength(1)
    expect(toastMessages[0]).toContain("gpt-5.5")
    expect(state.currentModel).toBe("openai/gpt-5.5")
  })

  it("#given invalid retry payload after prepareFallback #when dispatchFallbackRetry runs #then full fallback state rolls back", async () => {
    // given
    const deps = createDeps()
    const abortCalls: Array<{ sessionID: string; source: string }> = []
    const sessionID = "fallback-dispatch-invalid-payload"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(abortCalls)
    helpers.autoRetryWithFallback = async (_sessionID, _model, _resolvedAgent, _source, callbacks) => {
      callbacks?.onPromptFailedBeforeAccept?.()
      return { accepted: false, status: "invalid-model", reason: "test invalid model" }
    }

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["invalid-model-without-provider"],
      resolvedAgent: "test-agent",
      source: "session.error",
    })

    // then
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    expect([...state.failedModels.entries()]).toEqual([])
  })
})

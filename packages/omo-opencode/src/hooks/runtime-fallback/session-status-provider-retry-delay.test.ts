import { describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

function createContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 4,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      first_progress_timeout_seconds: 30,
      stall_timeout_seconds: 600,
      hard_timeout_seconds: 1800,
      notify_on_fallback: false,
      restore_primary_after_cooldown: false,
    },
    options: undefined,
    pluginConfig: {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
        },
      },
    },
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

function createHelpers(abortCalls: string[], retryCalls: Array<{ sessionID: string; model: string; source: string }>): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: () => {},
    clearSessionFallbackState: () => {},
    scheduleSessionFallbackTimeout: () => {},
    refreshSessionFallbackTimeout: () => false,
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
      return { accepted: true, status: "dispatched" }
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

describe("session.status provider retry fallback", () => {
  it("#given a short transient provider retry on attempt one #when session.status is handled #then runtime fallback waits", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-openai-transient-provider-retry"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.5")
    deps.sessionStates.set(sessionID, state)
    deps.sessionFallbackUnsafeToReplay.add(sessionID)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.5",
      status: {
        type: "retry",
        attempt: 1,
        message: "Our servers are currently overloaded. Please try again later.",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackUnsafeToReplay.has(sessionID)).toBe(true)
    expect(state.currentModel).toBe("openai/gpt-5.5")
    expect(state.pendingFallbackModel).toBeUndefined()
    SessionCategoryRegistry.clear()
  })

  it("#given hard provider exhaustion on attempt one #when session.status is handled #then runtime fallback advances immediately", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-openai-provider-autoretry"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.5")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.5",
      status: {
        type: "retry",
        attempt: 1,
        message: "Too Many Requests: {\"error\":{\"message\":\"Sorry, you've exceeded your 5 hour session limits.\",\"code\":\"user_global_rate_limited:pro_plus\"}}",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([{
      sessionID,
      model: "openai/gpt-5.4",
      source: "session.status",
    }])
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(true)
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    SessionCategoryRegistry.clear()
  })
})

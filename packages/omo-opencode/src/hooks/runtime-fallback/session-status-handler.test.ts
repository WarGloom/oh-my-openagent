import { describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { clearSessionModel, setSessionModel } from "../../shared/session-model-state"
import {
  delegatedTaskSessions,
  setSessionAgent,
  subagentSessions,
  updateSessionAgent,
  _resetForTesting as resetClaudeCodeSessionState,
} from "../../features/claude-code-session-state"

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

describe("createSessionStatusHandler", () => {
  it("#given a background-owned subagent session #when provider retry status arrives #then runtime fallback skips in-place retry", async () => {
    // given
    SessionCategoryRegistry.clear()
    resetClaudeCodeSessionState()
    const sessionID = "session-status-background-owned"
    SessionCategoryRegistry.register(sessionID, "test")
    subagentSessions.add(sessionID)

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("github-copilot/claude-haiku-4.5")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "github-copilot/claude-haiku-4.5",
      status: {
        type: "retry",
        attempt: 1,
        message: "All credentials for model claude-haiku-4.5 are cooling down [retrying in 7m 56s attempt #1]",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.size).toBe(0)
    expect(state.currentModel).toBe("github-copilot/claude-haiku-4.5")
    resetClaudeCodeSessionState()
    SessionCategoryRegistry.clear()
  })

  it("#given a superseded delegated child session still has a delegated-task marker #when provider retry status arrives #then runtime fallback does not create a second retry", async () => {
    // given
    SessionCategoryRegistry.clear()
    resetClaudeCodeSessionState()
    const sessionID = "session-status-superseded-child"
    SessionCategoryRegistry.register(sessionID, "test")
    setSessionAgent(sessionID, "explore")
    delegatedTaskSessions.add(sessionID)

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("github-copilot/claude-haiku-4.5")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "github-copilot/claude-haiku-4.5",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model claude-haiku-4.5 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.size).toBe(0)
    expect(state.currentModel).toBe("github-copilot/claude-haiku-4.5")
    resetClaudeCodeSessionState()
    SessionCategoryRegistry.clear()
  })

  it("#given a top-level Ultraworker session has an agent owner #when Anthropic quota retry status arrives #then runtime fallback advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    resetClaudeCodeSessionState()
    const sessionID = "session-status-ultraworker-parent"
    updateSessionAgent(sessionID, "Sisyphus - Ultraworker")

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      agents: {
        sisyphus: {
          fallback_models: ["anthropic/claude-opus-4-7(max)", "openai/gpt-5.5"],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    const helpers = createHelpers(abortCalls, retryCalls)
    helpers.resolveAgentForSessionFromContext = async () => "sisyphus"
    const handler = createSessionStatusHandler(deps, helpers, deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-7",
      status: {
        type: "retry",
        attempt: 5,
        message:
          "Claude Code returned an error result: You've hit your limit · resets 5:40pm (Asia/Jerusalem) [retrying in 8s attempt #5]",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.5",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("openai/gpt-5.5")
    resetClaudeCodeSessionState()
    SessionCategoryRegistry.clear()
  })

  it("#given a top-level Ultraworker session receives a Claude Code monthly spend retry #when stderr warning noise is present #then runtime fallback advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    resetClaudeCodeSessionState()
    const sessionID = "session-status-monthly-spend-parent"
    updateSessionAgent(sessionID, "Sisyphus - Ultraworker")

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      agents: {
        sisyphus: {
          fallback_models: ["anthropic/claude-opus-4-7(max)", "openai/gpt-5.5"],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    const helpers = createHelpers(abortCalls, retryCalls)
    helpers.resolveAgentForSessionFromContext = async () => "sisyphus"
    const handler = createSessionStatusHandler(deps, helpers, deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-7",
      status: {
        type: "retry",
        attempt: 2,
        message:
          "Claude Code returned an error result: You've hit your monthly spend limit · raise it at claude.ai/settings/usage\nSubprocess stderr: Permission deny rule \"MultiEdit\" matches no known tool — check for typos.\nWarning: Custom betas are only available for API key users. Ignoring provided betas.",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.5",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("openai/gpt-5.5")
    resetClaudeCodeSessionState()
    SessionCategoryRegistry.clear()
  })

  it("#given pending fallback prompt may already be accepted #when provider retry status arrives #then it keeps waiting for that accepted prompt", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-ambiguous-pending"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.pendingFallbackPromptMayHaveBeenAccepted = true
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(true)
    SessionCategoryRegistry.clear()
  })

  it("#given a pending fallback model #when a new provider cooldown retry arrives #then the handler overrides the pending fallback and advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-pending-fallback"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-7", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "google/gemini-2.5-pro",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
    SessionCategoryRegistry.clear()
  })

  it("#given timeout_seconds is disabled but first-progress timeout is enabled #when provider cooldown retry arrives #then the handler overrides pending fallback", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-new-timeout-field-overrides-pending"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.config.timeout_seconds = 0
    deps.config.first_progress_timeout_seconds = 30
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-7", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "google/gemini-2.5-pro",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
    SessionCategoryRegistry.clear()
  })

  it("#given an OpenAI processing-failure retry message without auto-retry signal #when session.status is handled #then runtime fallback advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-openai-processing-failure"
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
        attempt: 2,
        message: "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 27758447-523d-466f-917c-ce1ec6908fc8 in your message.",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    SessionCategoryRegistry.clear()
  })

  it("#given an unavailable-tool retry message #when session.status is handled #then runtime fallback does not launch", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-unavailable-tool"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-7",
      status: {
        type: "retry",
        attempt: 1,
        message: "Model tried to call unavailable tool 'mcp__plugin_serena_serena__activate_project'. Tool not available. Please try again.",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.size).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    SessionCategoryRegistry.clear()
  })

  it("#given current model differs only by variant from first fallback #when session.status is handled #then fallback skips to next identity", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-variant-loop"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["anthropic/claude-opus-4-7(max)", "github-copilot/claude-opus-4.6(high)"],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "anthropic/claude-opus-4-7"
    state.fallbackIndex = -1
    state.attemptCount = 1
    state.failedModels.set("openai/gpt-5.5", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-7",
      status: {
        type: "retry",
        attempt: 2,
        message: "Claude Code returned an error result: You've hit your limit · resets 5:30pm (Asia/Jerusalem)",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "github-copilot/claude-opus-4.6(high)",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("github-copilot/claude-opus-4.6(high)")
    expect(state.fallbackIndex).toBe(1)
    expect(state.attemptCount).toBe(2)
    SessionCategoryRegistry.clear()
  })

  it("#given a stale Claude Code quota retry after fallback moved providers #when session.status omits the event model #then runtime fallback ignores the retry", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-stale-provider-retry"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: [
            "anthropic/claude-opus-4-7(max)",
            "github-copilot/claude-opus-4.6(high)",
            "openai/gpt-5.4(xhigh)",
            "google/gemini-2.5-pro(high)",
            "opencode/big-pickle(max)",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "google/gemini-2.5-pro(high)"
    state.fallbackIndex = 3
    state.attemptCount = 4
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      status: {
        type: "retry",
        attempt: 2,
        message: "Claude Code returned an error result: You've hit your limit · resets 1:30am (Asia/Jerusalem)",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.size).toBe(0)
    expect(state.currentModel).toBe("google/gemini-2.5-pro(high)")
    expect(state.fallbackIndex).toBe(3)
    expect(state.attemptCount).toBe(4)
    SessionCategoryRegistry.clear()
  })

  it("#given ultrawork synced the session model before runtime state exists #when provider retry arrives #then bootstrap starts from the ultrawork model", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-ultrawork-bootstrap"
    SessionCategoryRegistry.register(sessionID, "test")
    clearSessionModel(sessionID)
    setSessionModel(sessionID, { providerID: "anthropic", modelID: "claude-opus-4-7" })

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: [
            "anthropic/claude-opus-4-7(max)",
            "github-copilot/claude-opus-4.6(high)",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      status: {
        type: "retry",
        attempt: 2,
        message: "Claude Code returned an error result: You've hit your limit · resets 1:30am (Asia/Jerusalem)",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "github-copilot/claude-opus-4.6(high)",
        source: "session.status",
      },
    ])
    expect(deps.sessionStates.get(sessionID)?.originalModel).toBe("anthropic/claude-opus-4-7")
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("github-copilot/claude-opus-4.6(high)")
    clearSessionModel(sessionID)
    SessionCategoryRegistry.clear()
  })

  it("#given fallback abort marker and no next fallback model #when session.status cannot prepare fallback #then marker is cleared", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-no-next-model"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["anthropic/claude-opus-4-7(max)"],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "anthropic/claude-opus-4-7"
    state.fallbackIndex = -1
    state.attemptCount = 1
    deps.sessionStates.set(sessionID, state)
    deps.sessionFallbackAbortInFlight.add(sessionID)

    const handler = createSessionStatusHandler(deps, createHelpers(abortCalls, retryCalls), deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-7",
      status: {
        type: "retry",
        attempt: 2,
        message: "Claude Code returned an error result: You've hit your limit · resets 5:30pm (Asia/Jerusalem)",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(retryCalls).toEqual([])
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    SessionCategoryRegistry.clear()
  })
})

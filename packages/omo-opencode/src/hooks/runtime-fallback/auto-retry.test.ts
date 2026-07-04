/// <reference types="bun-types" />

import { afterEach, describe, expect, it, test } from "bun:test"

import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { setPromptReservation } from "../../shared/prompt-async-gate/reservations"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { createAutoRetryHelpers } from "./auto-retry"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createFallbackState } from "./fallback-state"
import { installRuntimeFallbackTestClock, restoreRuntimeFallbackTestClock } from "./test-timeout-clock.test-support"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
type PromptInput = Parameters<RuntimeFallbackPluginInput["client"]["session"]["promptAsync"]>[0]

type PromptRecorder = {
  calls: PromptInput[]
  count: number
}

function createPromptRecorder(): PromptRecorder {
  return { calls: [], count: 0 }
}

function createDefaultMessagesResponse() {
  return {
    data: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "retry this" }],
      },
    ],
  }
}

function createContext(
  messagesResponse: unknown,
  promptRecorder: PromptRecorder,
  statusResponse: unknown = { data: {} },
): RuntimeFallbackPluginInput {
  const session = {
    abort: async () => ({}),
    messages: async () => messagesResponse,
    promptAsync: async (input: PromptInput) => {
      promptRecorder.calls.push(input)
      promptRecorder.count += 1
      return {}
    },
    status: async () => statusResponse,
  }

  return {
    client: {
      session,
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(
  messagesResponse: unknown,
  promptRecorder: PromptRecorder,
  statusResponse?: unknown,
): HookDeps {
  return {
    ctx: createContext(messagesResponse, promptRecorder, statusResponse),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 0,
      first_progress_timeout_seconds: 0,
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

function reservePromptGate(sessionID: string, holdMs: number): void {
  setPromptReservation(sessionID, {
    source: "user-prompt",
    dedupeKey: "runtime-fallback-test-reservation",
    reservedAt: Date.now(),
    token: Symbol("runtime-fallback-test-reservation"),
    expiresAt: Date.now() + holdMs,
  })
}

async function flushPromptGateMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

describe("createAutoRetryHelpers", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
    restoreRuntimeFallbackTestClock()
    SessionCategoryRegistry.clear()
  })

  it("#given fallback prompt returns ambiguous EOF #when auto retry runs #then pending fallback is marked as possibly accepted", async () => {
    // given
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.ctx.client.session.promptAsync = async (input: PromptInput) => {
      promptRecorder.calls.push(input)
      promptRecorder.count += 1
      throw new Error("JSON Parse error: Unexpected EOF")
    }
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-auto-retry-ambiguous"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)

    // when
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.error")

    // then
    expect(promptRecorder.count).toBe(1)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(true)
  })

  it("#given fallback abort marker #when retry prompt dispatches #then marker stays until result events settle", async () => {
    // given
    const sessionID = "session-retry-dispatched"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "continue" }] }],
    }, promptRecorder)
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    deps.sessionFallbackAbortInFlight.add(sessionID)
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7(max)", "sisyphus", "session.status")

    // then
    expect(promptRecorder.calls.length).toBe(1)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(true)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
  })

  it("#given latest assistant retry turn looks active #when provider retry requests fallback #then retry prompt bypasses tool-state gate", async () => {
    // given
    const sessionID = "session-active-assistant-runtime-fallback"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "retry this" }] },
        { info: { role: "assistant", finish: "unknown" }, parts: [{ type: "step-start" }] },
      ],
    }, promptRecorder)
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.status")

    // then
    const retryBody = promptRecorder.calls[0]?.body as {
      model?: { providerID?: string; modelID?: string }
    } | undefined
    expect(promptRecorder.count).toBe(1)
    expect(retryBody?.model).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
  })

  it("#given a sync task prompt reservation #when provider retry aborts it #then fallback prompt can dispatch", async () => {
    // given
    const sessionID = "session-sync-reservation-runtime-fallback"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))
    const helpers = createAutoRetryHelpers(deps)

    let syncPromptStarted!: () => void
    const syncPromptStartedPromise = new Promise<void>((resolve) => {
      syncPromptStarted = resolve
    })
    const syncDispatchResult = dispatchInternalPrompt({
      mode: "sync",
      client: {
        session: {
          prompt: async () => {
            syncPromptStarted()
            return new Promise(() => {})
          },
        },
      },
      sessionID,
      input: { path: { id: sessionID }, body: {} },
      source: "model-suggestion-retry:sync",
      settleMs: 0,
      postDispatchHoldMs: 2000,
      dispatchTimeoutMs: 20,
      checkStatus: false,
      checkToolState: false,
      queueBehavior: "defer",
    })
    await syncPromptStartedPromise

    // when
    await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4(high)", "metis", "session.status")
    const syncResult = await syncDispatchResult

    // then
    const retryBody = promptRecorder.calls[0]?.body as {
      model?: { providerID?: string; modelID?: string }
      variant?: unknown
    } | undefined

    expect(syncResult.status).toBe("failed")
    expect(promptRecorder.count).toBe(1)
    expect(retryBody?.model).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
    expect(retryBody?.variant).toBe("high")
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
  })

  it("#given fallback abort marker #when retry prompt cannot dispatch #then marker is cleared", async () => {
    // given
    const sessionID = "session-retry-not-dispatched"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({ data: [] }, promptRecorder)
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    deps.sessionFallbackAbortInFlight.add(sessionID)
    Reflect.deleteProperty(deps.ctx.client.session, "promptAsync")
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7(max)", "sisyphus", "session.status")

    // then
    expect(promptRecorder.calls.length).toBe(0)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
  })

  it("#given fallback abort marker #when fallback model payload is invalid #then marker is cleared", async () => {
    // given
    const sessionID = "session-invalid-fallback-model"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "continue" }] }],
    }, promptRecorder)
    const state = createFallbackState("openai/gpt-5.5")
    state.pendingFallbackModel = "claude-opus-4-7"
    deps.sessionStates.set(sessionID, state)
    deps.sessionFallbackAbortInFlight.add(sessionID)
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "claude-opus-4-7", "sisyphus", "session.status")

    // then
    expect(promptRecorder.calls.length).toBe(0)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given fallback result is awaiting without armed timer #when progress refreshes timeout #then watchdog is rearmed", () => {
    // given
    const sessionID = "session-awaiting-without-timer"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({ data: [] }, promptRecorder)
    deps.options = { session_timeout_ms: 1000 }
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackTimeoutAgents.set(sessionID, "sisyphus")
    const helpers = createAutoRetryHelpers(deps)

    // when
    const refreshed = helpers.refreshSessionFallbackTimeout(sessionID, "tool.execute.before:task")

    // then
    expect(refreshed).toBe(true)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
    expect(deps.sessionFallbackTimeoutAgents.get(sessionID)).toBe("sisyphus")

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("#given fallback retry makes assistant progress #when first-progress timeout passes #then retry is not advanced", async () => {
    // given
    const sessionID = "session-progress-keeps-current-model"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    let abortCount = 0
    deps.ctx.client.session.abort = async () => {
      abortCount += 1
      return {}
    }
    deps.config.first_progress_timeout_seconds = 0.02
    deps.config.stall_timeout_seconds = 1
    deps.config.hard_timeout_seconds = 0
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7", undefined, "session.error")
    const refreshed = helpers.refreshSessionFallbackTimeout(sessionID, "message.updated.progress")
    await new Promise((resolve) => setTimeout(resolve, 60))

    // then
    expect(refreshed).toBe(true)
    expect(promptRecorder.count).toBe(1)
    expect(abortCount).toBe(0)

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("#given fallback retry stalls after assistant progress #when stall timeout passes #then fallback advances", async () => {
    // given
    const sessionID = "session-progress-stall-advances"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["anthropic/claude-opus-4-7", "openai/gpt-5.4"],
        },
      },
    }
    deps.config.first_progress_timeout_seconds = 1
    deps.config.stall_timeout_seconds = 0.02
    deps.config.hard_timeout_seconds = 0
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "anthropic/claude-opus-4-7"
    state.pendingFallbackModel = "anthropic/claude-opus-4-7"
    deps.sessionStates.set(sessionID, state)
    SessionCategoryRegistry.register(sessionID, "test")
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7", undefined, "session.error")
    helpers.refreshSessionFallbackTimeout(sessionID, "message.updated.progress")
    await new Promise((resolve) => setTimeout(resolve, 60))

    // then
    expect(promptRecorder.count).toBe(2)
    expect(promptRecorder.calls[1]?.body.model).toEqual({ providerID: "openai", modelID: "gpt-5.4" })

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("#given timeout-driven fallback is rejected by prompt gate #when stall timeout advances fallback #then full fallback state is restored", async () => {
    // given
    const sessionID = "session-timeout-fallback-gate-rejected"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["anthropic/claude-opus-4-7", "openai/gpt-5.4"],
        },
      },
    }
    deps.config.first_progress_timeout_seconds = 1
    deps.config.stall_timeout_seconds = 0.02
    deps.config.hard_timeout_seconds = 0
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "anthropic/claude-opus-4-7"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "anthropic/claude-opus-4-7"
    state.pendingFallbackPromptMayHaveBeenAccepted = true
    state.failedModels.set("openai/gpt-5.5", 12345)
    deps.sessionStates.set(sessionID, state)
    SessionCategoryRegistry.register(sessionID, "test")
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7", undefined, "session.error")
    state.pendingFallbackModel = "anthropic/claude-opus-4-7"
    Reflect.deleteProperty(deps.ctx.client.session, "promptAsync")
    helpers.refreshSessionFallbackTimeout(sessionID, "message.updated.progress")
    await new Promise((resolve) => setTimeout(resolve, 60))

    // then
    expect(promptRecorder.count).toBe(1)
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(0)
    expect(state.attemptCount).toBe(1)
    expect(state.pendingFallbackModel).toBe("anthropic/claude-opus-4-7")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(false)
    expect(state.failedModels.get("openai/gpt-5.5")).toBe(12345)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
    expect(deps.sessionFallbackHardTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("#given fallback retry stalls after tool progress #when stall timeout passes #then prompt is not replayed", async () => {
    // given
    const sessionID = "session-tool-progress-stall-no-replay"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    let abortCount = 0
    deps.ctx.client.session.abort = async () => {
      abortCount += 1
      return {}
    }
    deps.pluginConfig = {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["anthropic/claude-opus-4-7", "openai/gpt-5.4"],
        },
      },
    }
    deps.config.first_progress_timeout_seconds = 1
    deps.config.stall_timeout_seconds = 0.02
    deps.config.hard_timeout_seconds = 0
    const state = createFallbackState("openai/gpt-5.5")
    state.currentModel = "anthropic/claude-opus-4-7"
    state.pendingFallbackModel = "anthropic/claude-opus-4-7"
    deps.sessionStates.set(sessionID, state)
    SessionCategoryRegistry.register(sessionID, "test")
    const helpers = createAutoRetryHelpers(deps)

    // when
    await helpers.autoRetryWithFallback(sessionID, "anthropic/claude-opus-4-7", undefined, "session.error")
    helpers.refreshSessionFallbackTimeout(sessionID, "tool.execute.before:bash")
    await new Promise((resolve) => setTimeout(resolve, 60))

    // then
    expect(abortCount).toBe(1)
    expect(promptRecorder.count).toBe(1)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackUnsafeToReplay.has(sessionID)).toBe(true)
    expect(deps.internallyAbortedSessions.has(sessionID)).toBe(true)

    helpers.clearSessionFallbackState(sessionID)
  })

  it("#given stale fallback abort state #when cleanupStaleSessions runs #then internal abort markers are cleared", () => {
    // given
    const sessionID = "session-stale-internal-abort"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps({ data: [] }, promptRecorder)
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    deps.sessionLastAccess.set(sessionID, Date.now() - (31 * 60 * 1000))
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionFallbackAbortInFlight.add(sessionID)
    deps.sessionFallbackUnsafeToReplay.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    deps.internallyAbortedSessions.add(sessionID)
    const helpers = createAutoRetryHelpers(deps)

    // when
    helpers.cleanupStaleSessions()

    // then
    expect(deps.sessionStates.has(sessionID)).toBe(false)
    expect(deps.sessionLastAccess.has(sessionID)).toBe(false)
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackAbortInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackUnsafeToReplay.has(sessionID)).toBe(false)
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.internallyAbortedSessions.has(sessionID)).toBe(false)
  })

  it("#given an existing fallback result is pending #when a new fallback retry is skipped by the prompt gate #then the previous pending state is preserved", async () => {
    // given
    const sessionID = "session-auto-retry"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(
      createDefaultMessagesResponse(),
      promptRecorder,
      { data: { [sessionID]: { type: "busy" } } },
    )
    const helpers = createAutoRetryHelpers(deps)
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)

    // when
    await helpers.autoRetryWithFallback(sessionID, "google/gemini-2.5-pro", undefined, "session.status")

    // then
    expect(promptRecorder.count).toBe(0)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
  })
  test("#given compact-flushed session with no recoverable user parts #when auto-retry fires the synthetic continuation #then the injected prompt is marked synthetic and carries the internal initiator marker (#4085)", async () => {
    // given - capture the actual parts forwarded to client.session.promptAsync
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    // Post-compact case: messages() returns no user role entries, so
    // getLastUserRetryPayload falls through to the synthetic "continue".
    deps.ctx.client.session.messages = async () => ({ data: [] })
    let lastBody: unknown
    deps.ctx.client.session.promptAsync = async (input: PromptInput) => {
      promptRecorder.calls.push(input)
      promptRecorder.count += 1
      lastBody = input.body
      return {}
    }
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-compact-flushed"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    // when
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.error")

    // then
    expect(promptRecorder.count).toBe(1)
    const body = lastBody as { parts?: ReadonlyArray<Record<string, unknown>> } | undefined
    expect(body).toBeDefined()
    const parts = body?.parts ?? []
    expect(parts.length).toBe(1)
    const firstPart = parts[0] ?? {}
    expect(firstPart["type"]).toBe("text")
    expect(firstPart["synthetic"]).toBe(true)
    expect(String(firstPart["text"] ?? "")).toContain("OMO_INTERNAL_INITIATOR")
  })

  it("#given first fallback retry cannot dispatch because promptAsync is unavailable #when retry runs #then fallback state is unchanged", async () => {
    // given
    const sessionID = "session-auto-retry-no-dispatch"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    Reflect.deleteProperty(deps.ctx.client.session, "promptAsync")
    const helpers = createAutoRetryHelpers(deps)
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    // when
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.status")

    // then
    expect(promptRecorder.count).toBe(0)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given prepared fallback retry sees a stale reservation #when the reservation releases #then fallback dispatch is retried", async () => {
    // given
    const sessionID = "session-dispatch-fallback-reserved"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.config.notify_on_fallback = true
    const toastCalls: Array<Parameters<RuntimeFallbackPluginInput["client"]["tui"]["showToast"]>[0]> = []
    deps.ctx.client.tui.showToast = async (input) => {
      toastCalls.push(input)
      return {}
    }
    const state = createFallbackState("anthropic/claude-fable-5")
    deps.sessionStates.set(sessionID, state)
    const helpers = createAutoRetryHelpers(deps)
    const clock = installRuntimeFallbackTestClock()
    reservePromptGate(sessionID, 250)

    // when
    const dispatchResult = dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.5(xhigh)"],
      resolvedAgent: "prometheus",
      source: "session.status",
    })
    await flushPromptGateMicrotasks()
    await clock.advanceBy(500)
    await dispatchResult

    // then
    expect(promptRecorder.count).toBe(1)
    expect(toastCalls.map((call) => call.body.message)).toEqual(["Fallback queued for gpt-5.5(xhigh)"])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.originalModel).toBe("anthropic/claude-fable-5")
    expect(state.currentModel).toBe("openai/gpt-5.5(xhigh)")
    expect(state.fallbackIndex).toBe(0)
    expect(state.attemptCount).toBe(1)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.5(xhigh)")
    expect([...state.failedModels.keys()]).toEqual(["anthropic/claude-fable-5"])
  })

  it("#given prepared fallback retry cannot load messages #when retry dispatch fails before prompt acceptance #then prepared state rolls back", async () => {
    // given
    const sessionID = "session-dispatch-fallback-message-load-error"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.config.notify_on_fallback = true
    deps.ctx.client.session.messages = async () => {
      throw new Error("message load failed")
    }
    const toastCalls: Array<Parameters<RuntimeFallbackPluginInput["client"]["tui"]["showToast"]>[0]> = []
    deps.ctx.client.tui.showToast = async (input) => {
      toastCalls.push(input)
      return {}
    }
    const state = createFallbackState("anthropic/claude-fable-5")
    deps.sessionStates.set(sessionID, state)
    const helpers = createAutoRetryHelpers(deps)

    // when
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: ["openai/gpt-5.5(xhigh)"],
      resolvedAgent: "prometheus",
      source: "session.status",
    })

    // then
    expect(promptRecorder.count).toBe(0)
    expect(toastCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(state.originalModel).toBe("anthropic/claude-fable-5")
    expect(state.currentModel).toBe("anthropic/claude-fable-5")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    expect([...state.failedModels.entries()]).toEqual([])
  })

  it("#given first fallback retry sees a stale reservation #when the reservation releases #then fallback dispatch is retried", async () => {
    // given
    const sessionID = "session-auto-retry-reserved"
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)
    const helpers = createAutoRetryHelpers(deps)
    const clock = installRuntimeFallbackTestClock()
    reservePromptGate(sessionID, 250)

    // when
    const retryResult = helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.status")
    await flushPromptGateMicrotasks()
    await clock.advanceBy(500)
    await expect(retryResult).resolves.toEqual({ accepted: true, status: "queued" })

    // then
    expect(promptRecorder.count).toBe(1)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  it("#given a persisted user message with id and part ids #when auto retry runs #then the fallback prompt reuses the original messageID and part ids", async () => {
    // given
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    let capturedBody: Record<string, unknown> | undefined
    deps.ctx.client.session.messages = async () => ({
      data: [
        {
          info: { role: "user", id: "msg_original_user" },
          parts: [{ type: "text", text: "retry this", id: "prt_original" }],
        },
      ],
    })
    deps.ctx.client.session.promptAsync = async (input: { body: Record<string, unknown> }) => {
      promptRecorder.count += 1
      capturedBody = input.body
      return {}
    }
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-auto-retry-dedup"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    // when
    await helpers.autoRetryWithFallback(sessionID, "openai/gpt-5.4", undefined, "session.error")

    // then
    expect(promptRecorder.count).toBe(1)
    expect(capturedBody?.messageID).toBe("msg_original_user")
    expect(capturedBody?.parts).toEqual([{ type: "text", text: "retry this", id: "prt_original" }])
  })

  test("#given internal abort marker is set #when abort request runs #then stale cleanup TTL is refreshed", async () => {
    // given
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-internal-abort-refresh"
    const staleLastAccess = Date.now() - 31 * 60 * 1000
    deps.sessionLastAccess.set(sessionID, staleLastAccess)

    // when
    await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")

    // then
    expect(deps.internallyAbortedSessions.has(sessionID)).toBe(true)
    expect(deps.sessionLastAccess.get(sessionID)).toBeGreaterThan(staleLastAccess)
  })

  test("#given stale internal abort marker #when stale session cleanup runs #then the marker is cleared", () => {
    // given
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-stale-internal-abort"
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))
    deps.sessionLastAccess.set(sessionID, Date.now() - 31 * 60 * 1000)
    deps.internallyAbortedSessions.add(sessionID)

    // when
    helpers.cleanupStaleSessions()

    // then
    expect(deps.sessionStates.has(sessionID)).toBe(false)
    expect(deps.sessionLastAccess.has(sessionID)).toBe(false)
    expect(deps.internallyAbortedSessions.has(sessionID)).toBe(false)
  })
})

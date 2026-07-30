/// <reference types="bun-types" />

import { afterEach, describe, expect, it, test } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { OMO_RUNTIME_FALLBACK_RETRY_MARKER } from "../../shared/runtime-fallback-retry-marker"
import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
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

describe("createAutoRetryHelpers", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
    SessionCategoryRegistry.clear()
  })

  it("dispatches a fallback prompt with the requested model", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const sessionID = "session-auto-retry"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const outcome = await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.error",
    )

    expect(outcome.accepted).toBe(true)
    expect(promptRecorder.count).toBe(1)
    expect(promptRecorder.calls[0]?.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("preserves a variant in the fallback prompt payload", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const sessionID = "session-auto-retry-variant"
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))

    const helpers = createAutoRetryHelpers(deps)
    const outcome = await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4(high)",
      "metis",
      "session.status",
    )

    const body = promptRecorder.calls[0]?.body
    expect(outcome.accepted).toBe(true)
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
    expect(body.variant).toBe("high")

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  test("queues a newer fallback while a previous fallback result is pending", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-auto-retry-queued"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)

    const outcome = await helpers.autoRetryWithFallback(
      sessionID,
      "google/gemini-2.5-pro",
      undefined,
      "session.status",
    )

    expect(outcome).toEqual({ accepted: true, status: "queued" })
    expect(promptRecorder.count).toBe(0)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
  })

  it("marks an ambiguous prompt failure as possibly accepted", async () => {
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

    await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.error",
    )

    expect(promptRecorder.count).toBe(1)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackPromptMayHaveBeenAccepted).toBe(true)
  })

  it("bypasses the tool-state gate for a provider retry signal", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(
      {
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "retry this" }] },
          {
            info: { role: "assistant", finish: "unknown" },
            parts: [{ type: "step-start" }],
          },
        ],
      },
      promptRecorder,
    )
    const sessionID = "session-active-assistant-runtime-fallback"
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))

    const helpers = createAutoRetryHelpers(deps)
    await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.status",
    )

    expect(promptRecorder.count).toBe(1)
    expect(promptRecorder.calls[0]?.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  it("does not dispatch an invalid model and clears its pending state", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const sessionID = "session-invalid-fallback-model"
    const state = createFallbackState("openai/gpt-5.5")
    state.pendingFallbackModel = "claude-opus-4-7"
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const outcome = await helpers.autoRetryWithFallback(
      sessionID,
      "claude-opus-4-7",
      "sisyphus",
      "session.status",
    )

    expect(outcome).toEqual({
      accepted: false,
      status: "invalid-model",
      reason: "missing provider prefix",
    })
    expect(promptRecorder.count).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
  })

  it("leaves fallback state unchanged when promptAsync is unavailable", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const sessionID = "session-auto-retry-no-dispatch"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    deps.sessionStates.set(sessionID, state)
    Reflect.deleteProperty(deps.ctx.client.session, "promptAsync")

    const helpers = createAutoRetryHelpers(deps)
    await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.status",
    )

    expect(promptRecorder.count).toBe(0)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(state.currentModel).toBe("anthropic/claude-opus-4-7")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
    expect(state.pendingFallbackModel).toBeUndefined()
  })

  test("injects a synthetic continuation with the internal retry markers", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    deps.ctx.client.session.messages = async () => ({ data: [] })

    const helpers = createAutoRetryHelpers(deps)
    const sessionID = "session-compact-flushed"
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))

    await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.error",
    )

    expect(promptRecorder.count).toBe(1)
    const parts = promptRecorder.calls[0]?.body.parts ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("text")
    expect("synthetic" in (parts[0] ?? {}) && parts[0].synthetic).toBe(true)
    expect(String("text" in (parts[0] ?? {}) ? parts[0].text : "")).toContain(
      OMO_INTERNAL_INITIATOR_MARKER,
    )
    expect(String("text" in (parts[0] ?? {}) ? parts[0].text : "")).toContain(
      OMO_RUNTIME_FALLBACK_RETRY_MARKER,
    )

    helpers.clearSessionFallbackTimeout(sessionID)
  })

  test("preserves an existing internal continuation part identity", async () => {
    const promptRecorder = createPromptRecorder()
    const deps = createDeps(createDefaultMessagesResponse(), promptRecorder)
    const internalText = `continue\n${OMO_INTERNAL_INITIATOR_MARKER}`

    deps.ctx.client.session.messages = async () => ({
      data: [
        {
          info: { role: "user", id: "msg_internal_continuation" },
          parts: [
            {
              type: "text",
              text: internalText,
              id: "prt_internal_continuation",
            },
          ],
        },
      ],
    })

    const sessionID = "session-reused-internal-continuation"
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-7"))
    const helpers = createAutoRetryHelpers(deps)

    await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      undefined,
      "session.error",
    )

    expect(promptRecorder.count).toBe(1)
    expect(promptRecorder.calls[0]?.body.messageID).toBe("msg_internal_continuation")
    expect(promptRecorder.calls[0]?.body.parts).toEqual([
      {
        type: "text",
        text: `${internalText}\n${OMO_RUNTIME_FALLBACK_RETRY_MARKER}`,
        id: "prt_internal_continuation",
      },
    ])

    helpers.clearSessionFallbackTimeout(sessionID)
  })
})

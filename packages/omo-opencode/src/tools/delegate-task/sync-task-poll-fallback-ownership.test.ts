/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import {
  subagentSessions,
  syncSubagentSessions,
} from "../../features/claude-code-session-state"
import { isDelegatedSessionOwnedByTask } from "../../hooks/runtime-fallback/delegated-session-ownership"
import {
  clearAllDelegatedChildSessionBootstrap,
  clearDelegatedChildSessionBootstrap,
  getDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap"
import { createRuntimeFallbackHook } from "../../hooks/runtime-fallback/hook"
import { NATIVE_RECOVERY_POLL_LIMIT } from "./sync-task-runner"

describe("sync task poll fallback ownership", () => {
  afterEach(() => {
    subagentSessions.clear()
    syncSubagentSessions.clear()
    clearAllDelegatedChildSessionBootstrap()
  })

  test("#given a poll error clears sync ownership #when retrying the same session #then anchors and restores ownership before the fallback prompt", async () => {
    //#given
    const { executeSyncTask } = require("./sync-task")
    const sessionID = "ses_weekly_limit"
    const ownershipAtPrompt: boolean[] = []
    const ownershipAtAnchor: boolean[] = []
    const pollAnchors: Array<number | undefined> = []
    const fetchAnchors: Array<number | undefined> = []
    let pollCount = 0
    let sessionCreatedCount = 0
    const weeklyLimitError =
      'Subagent entered retry status: Too Many Requests: {"error":{"message":"Sorry, you\'ve exceeded your weekly rate limit.","code":"user_weekly_rate_limited"}}'
    const deps = {
      createSyncSession: async () => ({ ok: true as const, sessionID }),
      sendSyncPrompt: async () => {
        ownershipAtPrompt.push(
          isDelegatedSessionOwnedByTask(sessionID) &&
            getDelegatedChildSessionBootstrap(sessionID) !== undefined,
        )
        return null
      },
      pollSyncSession: async (
        _ctx: unknown,
        _client: unknown,
        input: { anchorMessageCount?: number },
      ) => {
        pollAnchors.push(input.anchorMessageCount)
        pollCount++
        if (pollCount !== 1) return null
        subagentSessions.delete(sessionID)
        syncSubagentSessions.delete(sessionID)
        clearDelegatedChildSessionBootstrap(sessionID)
        return weeklyLimitError
      },
      fetchSyncResult: async (
        _client: unknown,
        _sessionID: string,
        anchorMessageCount?: number,
      ) => {
        fetchAnchors.push(anchorMessageCount)
        return { ok: true as const, textContent: "fallback completed" }
      },
      getSyncMessageCount: async () => {
        ownershipAtAnchor.push(isDelegatedSessionOwnedByTask(sessionID))
        return { ok: true as const, count: 4 }
      },
      isProviderExhaustionFallbackEligible: () => true,
    }

    //#when
    const result = await executeSyncTask(
      {
        prompt: "test prompt",
        description: "weekly fallback",
        category: "deep",
        load_skills: [],
        run_in_background: false,
      },
      {
        sessionID: "parent-session",
        callID: "call-weekly",
        metadata: () => {},
      },
      {
        client: {
          session: { create: async () => ({ data: { id: sessionID } }) },
        },
        directory: "/tmp",
        onSyncSessionCreated: async () => {
          sessionCreatedCount++
        },
        modelFallbackControllerAccessor: {
          setSessionFallbackChain: () => {},
          clearSessionFallbackChain: () => {},
        },
      },
      { sessionID: "parent-session" },
      "sisyphus-junior",
      { providerID: "anthropic", modelID: "claude-opus-4-8", variant: "max" },
      undefined,
      undefined,
      [
        {
          providers: ["github-copilot"],
          model: "claude-opus-4.8",
          variant: "max",
        },
        { providers: ["openai"], model: "gpt-5.6-sol", variant: "high" },
      ],
      deps,
    )

    //#then
    expect(result).toContain("fallback completed")
    expect(ownershipAtPrompt).toEqual([true, true])
    expect(ownershipAtAnchor).toEqual([true])
    expect(pollAnchors).toEqual([undefined, 4])
    expect(fetchAnchors).toEqual([4])
    expect(sessionCreatedCount).toBe(1)
  })

  function nativeClient() {
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_native_child" } }),
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: { showToast: async () => ({}) },
    }
    const runtime = createRuntimeFallbackHook({ client, directory: "/tmp" }, { config: { enabled: true } })
    runtime.native?.activate()
    return { client, dispose: () => runtime.dispose?.() }
  }

  function runNativeOwned(pollResults: ReadonlyArray<string | null>, client: unknown) {
    const { executeSyncTask } = require("./sync-task")
    const prompts: string[] = []
    let pollCount = 0
    const deps = {
      createSyncSession: async () => ({ ok: true as const, sessionID: "ses_native_child" }),
      sendSyncPrompt: async (_client: unknown, input: { categoryModel?: { modelID: string } }) => {
        prompts.push(input.categoryModel?.modelID ?? "none")
        return null
      },
      pollSyncSession: async () => pollResults[Math.min(pollCount++, pollResults.length - 1)] ?? null,
      fetchSyncResult: async () => ({ ok: true as const, textContent: "native fallback completed" }),
      getSyncMessageCount: async () => ({ ok: true as const, count: 2 }),
      isProviderExhaustionFallbackEligible: () => true,
    }
    const result = executeSyncTask(
      { prompt: "test prompt", description: "native fallback", category: "quick", load_skills: [], run_in_background: false },
      { sessionID: "parent-session", callID: "call-native", metadata: () => {} },
      { client, directory: "/tmp", modelFallbackControllerAccessor: { setSessionFallbackChain: () => {}, clearSessionFallbackChain: () => {} } },
      { sessionID: "parent-session" },
      "sisyphus-junior",
      { providerID: "anthropic", modelID: "claude-qa-missing" },
      undefined,
      undefined,
      [{ providers: ["anthropic"], model: "claude-haiku-4-5" }],
      deps,
    )
    return { result, prompts, polls: () => pollCount }
  }

  test("#given native fallback owns the client #when the poll reports a fallback-worthy error #then the same session is polled again without another prompt", async () => {
    //#given
    const native = nativeClient()
    const run = runNativeOwned(["Too Many Requests: rate limit", "Too Many Requests: rate limit", null], native.client)

    //#when
    const result = await run.result
    native.dispose()

    //#then
    expect(result).toContain("native fallback completed")
    expect(run.prompts).toEqual(["claude-qa-missing"])
    expect(run.polls()).toBe(3)
  })

  test("#given native fallback owns the client #when the same failure outlasts the recovery bound #then the error is returned without a re-prompt", async () => {
    //#given
    const native = nativeClient()
    const run = runNativeOwned(["Too Many Requests: rate limit"], native.client)

    //#when
    const result = await run.result
    native.dispose()

    //#then
    expect(result).toContain("Too Many Requests")
    expect(run.prompts).toEqual(["claude-qa-missing"])
    expect(run.polls()).toBe(NATIVE_RECOVERY_POLL_LIMIT + 1)
  })
})

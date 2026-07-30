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
})

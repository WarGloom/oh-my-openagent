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

describe("sync task prompt fallback ownership", () => {
  afterEach(() => {
    subagentSessions.clear()
    syncSubagentSessions.clear()
    clearAllDelegatedChildSessionBootstrap()
  })

  test("#given a prompt error clears sync ownership #when trying a fallback prompt #then anchors and restores ownership without recreating the session", async () => {
    //#given
    const { executeSyncTask } = require("./sync-task")
    const sessionID = "ses_prompt_fallback"
    const ownershipAtPrompt: boolean[] = []
    const ownershipAtAnchor: boolean[] = []
    const pollAnchors: Array<number | undefined> = []
    const fetchAnchors: Array<number | undefined> = []
    let promptCount = 0
    let sessionCreatedCount = 0
    const deps = {
      createSyncSession: async () => ({ ok: true as const, sessionID }),
      sendSyncPrompt: async () => {
        promptCount++
        ownershipAtPrompt.push(
          isDelegatedSessionOwnedByTask(sessionID) &&
            getDelegatedChildSessionBootstrap(sessionID) !== undefined,
        )
        if (promptCount === 1) {
          subagentSessions.delete(sessionID)
          syncSubagentSessions.delete(sessionID)
          clearDelegatedChildSessionBootstrap(sessionID)
          return "rate limit exceeded"
        }
        return null
      },
      pollSyncSession: async (
        _ctx: unknown,
        _client: unknown,
        input: { anchorMessageCount?: number },
      ) => {
        pollAnchors.push(input.anchorMessageCount)
        return null
      },
      fetchSyncResult: async (
        _client: unknown,
        _sessionID: string,
        anchorMessageCount?: number,
      ) => {
        fetchAnchors.push(anchorMessageCount)
        return { ok: true as const, textContent: "prompt fallback completed" }
      },
      getSyncMessageCount: async () => {
        ownershipAtAnchor.push(isDelegatedSessionOwnedByTask(sessionID))
        return { ok: true as const, count: 6 }
      },
      isProviderExhaustionFallbackEligible: () => true,
    }

    //#when
    const result = await executeSyncTask(
      {
        prompt: "test prompt",
        description: "prompt fallback",
        category: "deep",
        load_skills: [],
        run_in_background: false,
      },
      {
        sessionID: "parent-session",
        callID: "call-prompt",
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
        { providers: ["anthropic"], model: "claude-opus-4-8", variant: "max" },
        { providers: ["openai"], model: "gpt-5.6-sol", variant: "high" },
      ],
      deps,
    )

    //#then
    expect(result).toContain("prompt fallback completed")
    expect(ownershipAtPrompt).toEqual([true, true])
    expect(ownershipAtAnchor).toEqual([true])
    expect(pollAnchors).toEqual([6])
    expect(fetchAnchors).toEqual([6])
    expect(sessionCreatedCount).toBe(1)
  })
})

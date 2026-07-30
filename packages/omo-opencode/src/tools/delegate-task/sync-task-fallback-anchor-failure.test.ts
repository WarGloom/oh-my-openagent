/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

describe("sync task fallback anchor failure", () => {
  test("#given fallback anchor fetch fails #when a poll error selects fallback #then it returns the anchor error without accepting stale output", async () => {
    //#given
    const { executeSyncTask } = require("./sync-task")
    const sessionID = "ses_anchor_failure"
    let promptCount = 0
    let pollCount = 0
    let fetchCount = 0
    const deps = {
      createSyncSession: async () => ({ ok: true as const, sessionID }),
      sendSyncPrompt: async () => {
        promptCount++
        return null
      },
      pollSyncSession: async () => {
        pollCount++
        return "weekly rate limit exceeded"
      },
      fetchSyncResult: async () => {
        fetchCount++
        return { ok: true as const, textContent: "stale previous-turn output" }
      },
      getSyncMessageCount: async () => ({
        ok: false as const,
        error: `Error fetching fallback anchor: sdk unavailable\n\nSession ID: ${sessionID}`,
      }),
      isProviderExhaustionFallbackEligible: () => true,
    }

    //#when
    const result = await executeSyncTask(
      {
        prompt: "test prompt",
        description: "anchor failure",
        category: "deep",
        load_skills: [],
        run_in_background: false,
      },
      {
        sessionID: "parent-session",
        callID: "call-anchor-failure",
        metadata: () => {},
      },
      {
        client: {
          session: { create: async () => ({ data: { id: sessionID } }) },
        },
        directory: "/tmp",
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
    expect(result).toContain("Error fetching fallback anchor: sdk unavailable")
    expect(promptCount).toBe(1)
    expect(pollCount).toBe(1)
    expect(fetchCount).toBe(0)
  })
})

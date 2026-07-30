/// <reference path="../../../bun-test.d.ts" />

import { afterEach, describe, expect, it } from "bun:test"
import { setCompactionAgentConfigCheckpoint } from "../../shared/compaction-agent-config-checkpoint"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createCompactionContextInjector } from "./index"

const SESSION_ID = "ses_enqueue_cooldown"

type PromptAsyncInput = {
  path: { id: string }
  body: { parts: Array<{ type: "text"; text: string }> }
}

function createBusyContext() {
  const incompletePromptConfig = [
    {
      info: {
        role: "user",
        agent: "atlas",
        model: { providerID: "openai", modelID: "gpt-5" },
      },
    },
  ]
  const counters = { messages: 0, promptAsync: 0 }

  return {
    counters,
    ctx: {
      client: {
        session: {
          status: async () => ({ data: { [SESSION_ID]: { type: "busy" } } }),
          messages: async () => {
            counters.messages += 1
            return { data: incompletePromptConfig }
          },
          promptAsync: async (_input: PromptAsyncInput) => {
            counters.promptAsync += 1
            return {}
          },
        },
      },
      directory: "/tmp/test",
    },
  }
}

describe("recovery enqueue cooldown", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
  })

  it("#given recovery was queued because the session is busy #when compaction fires again inside the cooldown window #then recovery does not run again", async () => {
    // given
    const originalDateNow = Date.now
    const now = originalDateNow()
    Date.now = () => now

    const { ctx, counters } = createBusyContext()
    setCompactionAgentConfigCheckpoint(SESSION_ID, {
      agent: "atlas",
      model: { providerID: "openai", modelID: "gpt-5" },
      tools: { bash: true },
    })
    const injector = createCompactionContextInjector({ ctx })

    try {
      // when
      await injector.event({
        event: { type: "session.compacted", properties: { sessionID: SESSION_ID } },
      })
      const messagesAfterFirst = counters.messages
      await injector.event({
        event: { type: "session.compacted", properties: { sessionID: SESSION_ID } },
      })

      // then: the second event short-circuits at the cooldown guard before reading any
      // session messages, so the recovery body runs exactly once.
      expect(messagesAfterFirst).toBeGreaterThan(0)
      expect(counters.messages).toBe(messagesAfterFirst)
      expect(counters.promptAsync).toBe(0)
    } finally {
      Date.now = originalDateNow
    }
  })
})

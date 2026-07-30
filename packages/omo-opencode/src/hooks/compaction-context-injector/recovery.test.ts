/// <reference path="../../../../../bun-test.d.ts" />

import { afterEach, describe, expect, it } from "bun:test"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { setCompactionAgentConfigCheckpoint } from "../../shared/compaction-agent-config-checkpoint"
import { getSessionModel, setSessionModel } from "../../shared/session-model-state"
import { getSessionTools, setSessionTools } from "../../shared/session-tools-store"
import {
  dispatchInternalPrompt,
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../shared/prompt-async-gate"
import { createCompactionContextInjector } from "./index"
import { syncRecoveredSessionPromptState } from "./recovery"

type SessionMessageResponse = Array<{
  info?: Record<string, unknown>
}>

type PromptAsyncInput = {
  path: { id: string }
  body: {
    noReply?: boolean
    agent?: string
    model?: { providerID: string; modelID: string }
    tools?: Record<string, boolean>
    parts: Array<{
      type: "text"
      text: string
      synthetic?: true
      metadata?: { compaction_continue?: true }
    }>
  }
  query?: { directory: string }
}

function createPromptAsyncRecorder(): {
  calls: PromptAsyncInput[]
  promptAsync: (input: PromptAsyncInput) => Promise<Record<string, never>>
} {
  const calls: PromptAsyncInput[] = []

  return {
    calls,
    promptAsync: async (input: PromptAsyncInput) => {
      calls.push(input)
      return {}
    },
  }
}

function createMockContext(
  messageResponses: SessionMessageResponse[],
  promptAsync: (input: PromptAsyncInput) => Promise<Record<string, never>>,
) {
  let callIndex = 0

  return {
    client: {
      session: {
        messages: async () => {
          const response =
            messageResponses[Math.min(callIndex, messageResponses.length - 1)] ?? []
          callIndex += 1
          return { data: response }
        },
        promptAsync,
      },
    },
    directory: "/tmp/test",
  }
}

function createAssistantMessageUpdatedEvent(sessionID: string, messageID: string) {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          role: "assistant",
          sessionID,
        },
      },
    },
  } as const
}

function createMeaningfulPartUpdatedEvent(
  sessionID: string,
  messageID: string,
  type: "reasoning" | "tool_use",
) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          messageID,
          sessionID,
          type,
          ...(type === "reasoning" ? { text: "thinking" } : {}),
        },
      },
    },
  } as const
}

describe("createCompactionContextInjector recovery", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
  })

  it("re-injects after compaction when agent and model match but tools are missing", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const checkpointedPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const ctx = createMockContext(
      [
        checkpointedPromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        checkpointedPromptConfig,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })

    //#when
    await injector.capture("ses_missing_tools")
    await injector.event({
      event: { type: "session.compacted", properties: { sessionID: "ses_missing_tools" } },
    })

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(1)
    expect(promptAsyncRecorder.calls[0]?.body.agent).toBe("atlas")
    expect(releasePromptAsyncReservation("ses_missing_tools", "test-successful-recovery-released-hold", {
      reservedBy: "compaction-context-injector",
    })).toBe(false)
    expect(promptAsyncRecorder.calls[0]?.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(promptAsyncRecorder.calls[0]?.body.tools).toEqual({ bash: true })
    expect(getSessionModel("ses_missing_tools")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(getSessionTools("ses_missing_tools")).toEqual({ bash: true })
  })

  it("clears stale model and tools state when the recovered config omits them", () => {
    //#given
    const sessionID = "ses_clear_recovered_state"
    setSessionModel(sessionID, { providerID: "openai", modelID: "gpt-4.1" })
    setSessionTools(sessionID, { bash: true })

    //#when
    syncRecoveredSessionPromptState(sessionID, { agent: "atlas" })

    //#then
    expect(getSessionAgent(sessionID)).toBe("atlas")
    expect(getSessionModel(sessionID)).toBeUndefined()
    expect(getSessionTools(sessionID)).toBeUndefined()
  })

  it("#given recovery is blocked by a peer prompt hold #when compaction fires again after the hold is released #then queued recovery is not treated as completed", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const sessionID = "ses_recovery_peer_hold"
    setCompactionAgentConfigCheckpoint(sessionID, {
      agent: "atlas",
      model: { providerID: "openai", modelID: "gpt-5" },
      tools: { bash: true },
    })
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const ctx = createMockContext(
      [incompletePromptConfig],
      promptAsyncRecorder.promptAsync,
    )
    const hook = createCompactionContextInjector({ ctx })
    const peerHold = await dispatchInternalPrompt({
      mode: "async",
      client: ctx.client,
      sessionID,
      source: "test-peer-hold",
      settleMs: 0,
      postDispatchHoldMs: 1000,
      input: {
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: "peer message" }],
        },
      },
    })
    promptAsyncRecorder.calls.splice(0)

    //#when
    await hook.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })
    const released = releasePromptAsyncReservation(sessionID, "test-release", {
      reservedBy: "test-peer-hold",
    })
    await hook.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    //#then
    expect(peerHold.status).toBe("dispatched")
    expect(released).toBe(true)
    expect(promptAsyncRecorder.calls).toHaveLength(1)
    expect(releasePromptAsyncReservation(sessionID, "test-release-queued-recovery-hold", {
      reservedBy: "compaction-context-injector",
    })).toBe(true)
    expect(promptAsyncRecorder.calls[0]?.body.parts[0]?.text).toContain("restore checkpointed session agent configuration")
  })

  it("#given recovery is blocked by a peer prompt hold #when the hold is released without another compaction event #then recovery retries from the prompt queue", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const sessionID = "ses_recovery_peer_hold_queue_retry"
    setCompactionAgentConfigCheckpoint(sessionID, {
      agent: "atlas",
      model: { providerID: "openai", modelID: "gpt-5" },
      tools: { bash: true },
    })
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const recoveredPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const ctx = createMockContext(
      [
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        recoveredPromptConfig,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const hook = createCompactionContextInjector({ ctx })
    const peerHold = await dispatchInternalPrompt({
      mode: "async",
      client: ctx.client,
      sessionID,
      source: "test-peer-hold",
      settleMs: 0,
      postDispatchHoldMs: 1000,
      input: {
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: "peer message" }],
        },
      },
    })
    promptAsyncRecorder.calls.splice(0)

    //#when
    await hook.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })
    const released = releasePromptAsyncReservation(sessionID, "test-release", {
      reservedBy: "test-peer-hold",
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    //#then
    expect(peerHold.status).toBe("dispatched")
    expect(released).toBe(true)
    expect(promptAsyncRecorder.calls).toHaveLength(1)
    const queuedRecoveryCall = promptAsyncRecorder.calls[0]?.body
    expect(queuedRecoveryCall?.agent).toBe("atlas")
    expect(queuedRecoveryCall?.tools).toEqual({ bash: true })
  })

  it("marks the recovery prompt as synthetic compaction continuation", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const recoveredPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const ctx = createMockContext(
      [
        recoveredPromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        recoveredPromptConfig,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })

    //#when
    await injector.capture("ses_synthetic_recovery")
    await injector.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "ses_synthetic_recovery" },
      },
    })

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(1)
    const recoveryPart = promptAsyncRecorder.calls[0]?.body.parts[0]
    expect(recoveryPart?.synthetic).toBe(true)
    expect(recoveryPart?.metadata).toEqual({ compaction_continue: true })
  })

  it("does not immediately retry recovery when the recovered prompt config still mismatches expected model or tools", async () => {
    //#given
    const originalDateNow = Date.now
    let now = originalDateNow()
    Date.now = () => now

    const promptAsyncRecorder = createPromptAsyncRecorder()
    const mismatchResponse = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-4.1" },
        },
      },
    ]
    const ctx = createMockContext(
      [
        [
          {
            info: {
              role: "user",
              agent: "atlas",
              model: { providerID: "openai", modelID: "gpt-5" },
              tools: { bash: true },
            },
          },
        ],
        mismatchResponse,
        mismatchResponse,
        mismatchResponse,
        mismatchResponse,
        mismatchResponse,
        mismatchResponse,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })

    try {
      //#when
      await injector.capture("ses_retry_incomplete_recovery")
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "ses_retry_incomplete_recovery" },
        },
      })
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "ses_retry_incomplete_recovery" },
        },
      })

      //#then
      expect(promptAsyncRecorder.calls.length).toBe(1)

      //#when
      now += 61_000
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "ses_retry_incomplete_recovery" },
        },
      })

      //#then
      expect(promptAsyncRecorder.calls.length).toBe(2)
    } finally {
      Date.now = originalDateNow
    }
  })

  it("does not re-inject immediately after a successful recovery from the same compaction", async () => {
    //#given
    const originalDateNow = Date.now
    const now = originalDateNow()
    Date.now = () => now

    const promptAsyncRecorder = createPromptAsyncRecorder()
    const checkpointedPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const needsRecoveryConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const messageResponses: Array<Array<{ info: Record<string, unknown> }>> = [
      needsRecoveryConfig,
      needsRecoveryConfig,
      checkpointedPromptConfig,
      checkpointedPromptConfig,
    ]
    const ctx = createMockContext(
      messageResponses,
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })
    const sessionID = "ses_compacted_recent_recovery"
    setCompactionAgentConfigCheckpoint(sessionID, {
      agent: "atlas",
      model: { providerID: "openai", modelID: "gpt-5" },
      tools: { bash: true },
    })

    try {
      //#when
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID },
        },
      })
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID },
        },
      })

      //#then
      expect(promptAsyncRecorder.calls.length).toBe(1)
    } finally {
      Date.now = originalDateNow
    }
  })

  it("#given post-dispatch config read is stale #when a second compaction event arrives immediately #then recovery prompt is not duplicated", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const checkpointedPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const ctx = createMockContext(
      [
        checkpointedPromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })

    //#when
    await injector.capture("ses_stale_recovery_read")
    await injector.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "ses_stale_recovery_read" },
      },
    })
    await injector.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "ses_stale_recovery_read" },
      },
    })

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(1)
  })

  it("#given recovery promptAsync may have been accepted before EOF #when compaction repeats after the gate hold #then recovery is not duplicated", async () => {
    //#given
    const calls: PromptAsyncInput[] = []
    const checkpointedPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const incompletePromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    ]
    const ctx = createMockContext(
      [
        checkpointedPromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
        incompletePromptConfig,
      ],
      async (input: PromptAsyncInput) => {
        calls.push(input)
        throw new Error("JSON Parse error: Unexpected EOF")
      },
    )
    const injector = createCompactionContextInjector({ ctx })
    const sessionID = "ses_recovery_eof_duplicate"

    //#when
    await injector.capture(sessionID)
    await injector.event({
      event: {
        type: "session.compacted",
        properties: { sessionID },
      },
    })
    const released = releasePromptAsyncReservation(sessionID, "test:simulate-expired-hold", {
      reservedBy: "compaction-context-injector",
    })
    await injector.event({
      event: {
        type: "session.compacted",
        properties: { sessionID },
      },
    })

    //#then
    expect(released).toBe(true)
    expect(calls.length).toBe(1)
  })

  it("does not treat reasoning-only assistant messages as a no-text tail", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const matchingPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const ctx = createMockContext(
      [matchingPromptConfig, matchingPromptConfig, matchingPromptConfig],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })
    const sessionID = "ses_reasoning_tail"

    await injector.capture(sessionID)
    await injector.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })

    //#when
    for (let index = 1; index <= 5; index++) {
      const messageID = `msg_reasoning_${index}`
      await injector.event(createAssistantMessageUpdatedEvent(sessionID, messageID))
      await injector.event(
        createMeaningfulPartUpdatedEvent(sessionID, messageID, "reasoning"),
      )
      await injector.event({
        event: { type: "session.idle", properties: { sessionID } },
      })
    }

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(0)
  })

  it("does not treat tool_use-only assistant messages as a no-text tail", async () => {
    //#given
    const promptAsyncRecorder = createPromptAsyncRecorder()
    const matchingPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const ctx = createMockContext(
      [matchingPromptConfig, matchingPromptConfig, matchingPromptConfig],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })
    const sessionID = "ses_tool_use_tail"

    await injector.capture(sessionID)
    await injector.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })

    //#when
    for (let index = 1; index <= 5; index++) {
      const messageID = `msg_tool_use_${index}`
      await injector.event(createAssistantMessageUpdatedEvent(sessionID, messageID))
      await injector.event(
        createMeaningfulPartUpdatedEvent(sessionID, messageID, "tool_use"),
      )
      await injector.event({
        event: { type: "session.idle", properties: { sessionID } },
      })
    }

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(0)
  })

  it("does not run no-text-tail recovery again after a successful compaction recovery", async () => {
    //#given
    const originalDateNow = Date.now
    const now = originalDateNow()
    Date.now = () => now

    const promptAsyncRecorder = createPromptAsyncRecorder()
    const checkpointedPromptConfig = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: true },
        },
      },
    ]
    const missingToolsResponse = [
      {
        info: {
          role: "user",
          agent: "atlas",
          model: { providerID: "openai", modelID: "gpt-5" },
          tools: { bash: "allow" },
        },
      },
    ]
    const ctx = createMockContext(
      [
        checkpointedPromptConfig,
        missingToolsResponse,
        missingToolsResponse,
        checkpointedPromptConfig,
        checkpointedPromptConfig,
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })
    const sessionID = "ses_no_text_tail_recent_recovery"

    try {
      //#when
      await injector.capture(sessionID)
      await injector.event({
        event: {
          type: "session.compacted",
          properties: { sessionID },
        },
      })

      for (let index = 1; index <= 5; index++) {
        await injector.event(createAssistantMessageUpdatedEvent(sessionID, `nt_msg_${index}`))
      }
      await injector.event({
        event: { type: "session.idle", properties: { sessionID } },
      })

      for (let index = 6; index <= 10; index++) {
        await injector.event(createAssistantMessageUpdatedEvent(sessionID, `nt_msg_${index}`))
      }
      await injector.event({
        event: { type: "session.idle", properties: { sessionID } },
      })

      //#then
      expect(promptAsyncRecorder.calls.length).toBe(1)
    } finally {
      Date.now = originalDateNow
    }
  })

  it("falls back to the current non-compaction model when a checkpoint model is poisoned", async () => {
    //#given
    const sessionID = "ses_poisoned_checkpoint_model"
    const promptAsyncRecorder = createPromptAsyncRecorder()
    setCompactionAgentConfigCheckpoint(sessionID, {
      agent: "atlas",
      model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
      tools: { bash: true },
    })
    const ctx = createMockContext(
      [
        [
          {
            info: {
              role: "user",
              agent: "atlas",
              model: { providerID: "openai", modelID: "gpt-5" },
              tools: { bash: true },
            },
          },
          {
            info: {
              role: "user",
              agent: "compaction",
              model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
            },
          },
        ],
        [
          {
            info: {
              role: "user",
              agent: "compaction",
              model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
            },
          },
        ],
        [
          {
            info: {
              role: "user",
              agent: "atlas",
              model: { providerID: "openai", modelID: "gpt-5" },
              tools: { bash: true },
            },
          },
        ],
      ],
      promptAsyncRecorder.promptAsync,
    )
    const injector = createCompactionContextInjector({ ctx })

    //#when
    await injector.event({
      event: { type: "session.compacted", properties: { sessionID } },
    })

    //#then
    expect(promptAsyncRecorder.calls.length).toBe(1)
    expect(promptAsyncRecorder.calls[0]?.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })
})

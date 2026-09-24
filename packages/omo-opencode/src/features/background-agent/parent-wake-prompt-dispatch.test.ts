import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { PromptAsyncInput, PromptDispatchClient } from "@oh-my-opencode/utils/prompt-async-gate/types"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { clearSessionModel, getStoredSessionModel, setSessionModel } from "../../shared/session-model-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { clearSessionAgent, setSessionAgent } from "../claude-code-session-state/state"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { sendParentWakePrompt } from "./parent-wake-prompt-dispatch"

const SESSION_ID = "parent-session-gate-hold"
const HOLD_START_MS = new Date("2026-09-27T00:00:00.000Z").getTime()
const HOLD_MS = 2_000
const parentID = "parent-wake-model-b"
const childID = "explicit-child-model-c"

afterEach(() => {
  setSystemTime()
  clearSessionModel(parentID)
  clearSessionModel(childID)
  clearSessionAgent(parentID)
  releaseAllPromptAsyncReservationsForTesting()
})

function createClient(): PromptDispatchClient {
  return unsafeTestValue<PromptDispatchClient>({
    session: {
      status: async () => ({ data: { [SESSION_ID]: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      promptAsync: async () => ({}),
    },
  })
}

function createWake(notification: string): PendingParentWake {
  return {
    notifications: [notification],
    promptContext: { agent: "sisyphus" },
    shouldReply: true,
    queuedAt: HOLD_START_MS,
  }
}

async function dispatchAt(nowMs: number, client: PromptDispatchClient, wake: PendingParentWake): Promise<(number | undefined)[]> {
  setSystemTime(new Date(nowMs))
  const flushDelays: (number | undefined)[] = []
  await sendParentWakePrompt({
    client,
    directory: "/tmp",
    sessionID: SESSION_ID,
    latestWake: wake,
    emptyAssistantTurnRetry: false,
    toolWaitDecision: { defer: false },
    getDispatchedWake: () => undefined,
    hasRecordedPromptAfterDispatch: async () => false,
    trackDispatchedWake: () => {},
    requeueWake: () => {},
    scheduleFlush: (delayMs) => {
      flushDelays.push(delayMs)
    },
  })
  return flushDelays
}

describe("sendParentWakePrompt promptAsync gate hold", () => {
  test("#given a live parent-wake hold #when a wake first meets it #then it backs off a full hold so the live turn can consume the admission", async () => {
    // given
    const client = createClient()
    expect(await dispatchAt(HOLD_START_MS, client, createWake("<system-reminder>first</system-reminder>"))).toEqual([])

    // when
    const delays = await dispatchAt(HOLD_START_MS + 1_000, client, createWake("<system-reminder>second</system-reminder>"))

    // then
    expect(delays).toEqual([HOLD_MS])
  })

  test("#given a wake that already backed off for a hold #when its retry fires a tick before that hold expires #then it waits only the rest of that hold", async () => {
    // given
    const client = createClient()
    await dispatchAt(HOLD_START_MS, client, createWake("<system-reminder>first</system-reminder>"))
    const retried = createWake("<system-reminder>second</system-reminder>")
    expect(await dispatchAt(HOLD_START_MS + 3, client, retried)).toEqual([HOLD_MS])

    // when
    const delays = await dispatchAt(HOLD_START_MS + HOLD_MS - 5, client, retried)

    // then
    expect(delays).toEqual([5])
  })
})

async function dispatchWake(wake: PendingParentWake): Promise<{ sent: PromptAsyncInput[]; tracked: PendingParentWake[] }> {
  const sent: PromptAsyncInput[] = []
  const tracked: PendingParentWake[] = []
  const client = {
    session: {
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      promptAsync: async (input: PromptAsyncInput) => { sent.push(input); return { ok: true } },
    },
  } satisfies PromptDispatchClient & {
    session: { promptAsync: (input: PromptAsyncInput) => Promise<{ ok: boolean }> }
  }
  await sendParentWakePrompt({
    client,
    directory: "/repo",
    sessionID: parentID,
    latestWake: wake,
    emptyAssistantTurnRetry: false,
    toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: false },
    getDispatchedWake: () => undefined,
    hasRecordedPromptAfterDispatch: async () => false,
    trackDispatchedWake: (dispatched) => { tracked.push(dispatched) },
    requeueWake: () => {},
    scheduleFlush: () => {},
  })
  return { sent, tracked }
}

describe("delayed parent wake model selection", () => {
  test("uses parent B at dispatch while preserving tools, noReply, queued dedupe context and explicit child C", async () => {
    // given
    const wake: PendingParentWake = {
      promptContext: {
        model: { providerID: "provider-a", modelID: "model-a" },
        variant: "variant-a",
        agent: "agent-a",
        tools: { task: false },
      },
      notifications: ["task done"],
      shouldReply: false,
    }
    setSessionModel(parentID, { providerID: "provider-a", modelID: "model-a", variant: "variant-a" }, "agent-a")
    setSessionModel(childID, { providerID: "provider-c", modelID: "model-c", variant: "variant-c" }, "child-agent")
    setSessionModel(parentID, { providerID: "provider-b", modelID: "model-b", variant: "variant-b" }, "agent-b")

    // when
    const { sent, tracked } = await dispatchWake(wake)

    // then
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({
      model: { providerID: "provider-b", modelID: "model-b" },
      variant: "variant-b",
      agent: "agent-b",
      tools: { task: false },
      noReply: true,
    })
    expect(tracked[0]?.promptContext.model).toEqual({ providerID: "provider-a", modelID: "model-a" })
    expect(getStoredSessionModel(childID)).toMatchObject({ providerID: "provider-c", modelID: "model-c", variant: "variant-c", agent: "child-agent" })
  })

  test("keeps the enqueue-time parent selection when no live model exists", async () => {
    // given
    const wake: PendingParentWake = {
      promptContext: { model: { providerID: "provider-a", modelID: "model-a" }, variant: "variant-a", agent: "agent-a", tools: { task: false } },
      notifications: ["task done"],
      shouldReply: true,
    }
    setSessionAgent(parentID, "agent-b")

    // when
    const { sent } = await dispatchWake(wake)

    // then
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({
      model: { providerID: "provider-a", modelID: "model-a" },
      variant: "variant-a",
      agent: "agent-a",
      tools: { task: false },
      noReply: false,
    })
  })
})

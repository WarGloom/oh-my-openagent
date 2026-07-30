/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakePendingQueue } from "./parent-wake-pending-queue"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import { handleDispatchedParentWakeWindowElapsed } from "./parent-wake-window-recovery"

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]
type PromptAsyncCall = Parameters<ParentWakeNotifierClientForTest["session"]["promptAsync"]>[0]

type SessionMessageStub = {
  readonly info?: {
    readonly role?: string
    readonly finish?: string
    readonly error?: unknown
    readonly time?: { readonly created?: number; readonly updated?: number }
  }
  readonly parts?: readonly {
    readonly type?: string
    readonly text?: string
    readonly time?: { readonly created?: number; readonly updated?: number }
    readonly state?: { readonly time?: { readonly created?: number; readonly updated?: number } }
  }[]
}

const FINAL_WAKE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"

function createNotifier(args: {
  readonly sessionMessagesImpl?: (attempt: number) => Promise<unknown>
  readonly promptAsyncImpl?: (call: PromptAsyncCall, attempt: number) => Promise<unknown>
  readonly failureRequeueWindowMs?: number
  readonly parentSessionActivityInProgressWindowMs?: number
} = {}): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  let messagesAttempt = 0
  const sessionMessages: readonly SessionMessageStub[] = [
    {
      info: {
        role: "assistant",
        finish: "stop",
        time: { created: Date.now() - 10_000 },
      },
    },
  ]
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => {
        messagesAttempt += 1
        return args.sessionMessagesImpl?.(messagesAttempt) ?? { data: sessionMessages }
      },
      status: async () => ({ data: {} }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return args.promptAsyncImpl?.(call, promptAsyncCalls.length) ?? { data: {} }
      },
    },
  }
  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: args.failureRequeueWindowMs ?? 1,
      userMessageInProgressWindowMs: 0,
      ...(args.parentSessionActivityInProgressWindowMs !== undefined
        ? { parentSessionActivityInProgressWindowMs: args.parentSessionActivityInProgressWindowMs }
        : {}),
    },
  )
  return { notifier, promptAsyncCalls }
}

function releaseParentWakeHold(sessionID: string): void {
  const released = releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
  expect(released).toBe(true)
}

async function waitForTimer(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10)
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await waitForTimer()
  }
  expect(predicate()).toBe(true)
}

describe("ParentWakeNotifier late error recovery", () => {
  test("#given session.error arrives after the recovery window #when no assistant output accepted the wake #then the final wake is already requeued", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-late-session-error-after-window"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      await waitForTimer()

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(false)
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      releaseParentWakeHold(sessionID)
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(2)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given only the injected user wake is visible #when late session.error arrives #then the wake is requeued instead of treated as accepted", async () => {
    // given
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500 },
        },
      },
    ]
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => ({ data: sessionMessages }),
      promptAsyncImpl: async () => {
        sessionMessages.push({
          info: { role: "user", time: { created: Date.now() } },
          parts: [{ type: "text", text: FINAL_WAKE }],
        })
        return { data: {} }
      },
    })
    const sessionID = "parent-late-error-user-wake-only"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(true)

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(true)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given assistant error history has no parts #when late session.error arrives #then the wake is requeued", async () => {
    // given
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500 },
        },
      },
    ]
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => ({ data: sessionMessages }),
    })
    const sessionID = "parent-late-error-assistant-error-history"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      const wake = notifier.getDispatchedParentWakes().get(sessionID)
      if (!wake) {
        throw new Error("Missing dispatched parent wake")
      }
      wake.dispatchedAt = 1_000
      sessionMessages.push({
        info: {
          role: "assistant",
          finish: "error",
          error: { message: "provider failed after accepting promptAsync" },
          time: { created: 2_000 },
        },
      })

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(true)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given assistant output appears after the recovery window #when the wake timer inspects history #then the dispatched wake is cleared", async () => {
    // given
    let showAcceptedAssistantOutput = false
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              finish: "stop",
              time: { created: Date.now() - 10_000 },
            },
          },
          ...(showAcceptedAssistantOutput
            ? [{ info: { role: "assistant", finish: "stop", time: { created: Date.now() } } }]
            : []),
        ] satisfies readonly SessionMessageStub[],
      }),
    })
    const sessionID = "parent-late-window-accepted-output"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(true)

      // when
      showAcceptedAssistantOutput = true
      await waitForTimer()

      // then
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakeTimers().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given assistant output part is updated after the wake #when late session.error arrives #then accepted dispatch is not duplicated", async () => {
    // given
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500 },
        },
        parts: [{ type: "text", text: "collected the wake", time: { updated: 2_000 } }],
      },
    ]
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => ({ data: sessionMessages }),
    })
    const sessionID = "parent-late-error-updated-output"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      const wake = notifier.getDispatchedParentWakes().get(sessionID)
      if (!wake) {
        throw new Error("Missing dispatched parent wake")
      }
      wake.dispatchedAt = 1_000

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given old assistant output only has metadata updated after the wake #when late session.error arrives #then final wake is requeued", async () => {
    // given
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500, updated: 2_000 },
        },
        parts: [{ type: "text", text: "old output before wake" }],
      },
    ]
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => ({ data: sessionMessages }),
      failureRequeueWindowMs: 10_000,
    })
    const sessionID = "parent-late-error-metadata-only-update"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      const wake = notifier.getDispatchedParentWakes().get(sessionID)
      if (!wake) {
        throw new Error("Missing dispatched parent wake")
      }
      wake.dispatchedAt = 1_000

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(true)
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given reply-required wake is admitted noReply with no assistant output #when the recovery window elapses #then the wake is requeued as a reply", async () => {
    // given
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500 },
        },
      },
    ]
    const { notifier, promptAsyncCalls } = createNotifier({
      parentSessionActivityInProgressWindowMs: 5_000,
      sessionMessagesImpl: async () => ({ data: sessionMessages }),
      promptAsyncImpl: async (call) => {
        sessionMessages.push({
          info: { role: "user", time: { created: Date.now() } },
          parts: call.body.parts,
        })
        return { data: {} }
      },
    })
    const sessionID = "parent-no-reply-no-output-window"
    notifier.recordParentSessionActivity(sessionID)
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.replyRequiredNoReplyDispatch).toBe(true)

      // when
      await waitUntil(
        () =>
          notifier.getPendingParentWakes().has(sessionID)
          && !notifier.getDispatchedParentWakes().has(sessionID),
        600,
      )

      // then
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      releaseParentWakeHold(sessionID)
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).toBe(false)
      expect(JSON.stringify(promptAsyncCalls[1]?.body.parts)).toContain("ALL BACKGROUND TASKS COMPLETE")
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given reply-required noReply wake history is unreadable #when the recovery window elapses #then the wake timer is refreshed", async () => {
    // given
    const wake: PendingParentWake = {
      promptContext: { agent: "sisyphus" },
      notifications: [FINAL_WAKE],
      shouldReply: true,
      dispatchedAt: 1_000,
      replyRequiredNoReplyDispatch: true,
    }
    let clearWakeCount = 0
    let refreshWakeTimerCount = 0
    let clearActivityCount = 0
    let requeueWakeCount = 0
    let scheduleFlushCount = 0

    // when
    await handleDispatchedParentWakeWindowElapsed(unsafeTestValue<Parameters<typeof handleDispatchedParentWakeWindowElapsed>[0]>({
      sessionID: "parent-no-reply-unreadable-history",
      wake,
      dispatchedTracker: {
        getWake: () => wake,
        clearWake: () => {
          clearWakeCount += 1
        },
        refreshWakeTimer: () => {
          refreshWakeTimerCount += 1
        },
      },
      sessionInspector: {
        hasAssistantOrToolOutputAfterDispatchedWake: async () => "unknown",
        clearActivity: () => {
          clearActivityCount += 1
        },
      },
      requeueWake: () => {
        requeueWakeCount += 1
      },
      scheduleFlush: () => {
        scheduleFlushCount += 1
      },
    }))

    // then
    expect(refreshWakeTimerCount).toBe(1)
    expect(clearWakeCount).toBe(0)
    expect(clearActivityCount).toBe(0)
    expect(requeueWakeCount).toBe(0)
    expect(scheduleFlushCount).toBe(0)
  })

  test("#given dispatched wake changes during history inspection #when recovery resumes #then stale timer state is ignored", async () => {
    // given
    const wake: PendingParentWake = {
      promptContext: { agent: "sisyphus" },
      notifications: [FINAL_WAKE],
      shouldReply: true,
      dispatchedAt: 1_000,
      replyRequiredNoReplyDispatch: true,
    }
    const newerWake: PendingParentWake = {
      ...wake,
      notifications: [`${FINAL_WAKE}\nnewer`],
      dispatchedAt: 2_000,
    }
    let currentWake: PendingParentWake | undefined = wake
    let clearWakeCount = 0
    let refreshWakeTimerCount = 0
    let requeueWakeCount = 0
    let scheduleFlushCount = 0

    // when
    await handleDispatchedParentWakeWindowElapsed(unsafeTestValue<Parameters<typeof handleDispatchedParentWakeWindowElapsed>[0]>({
      sessionID: "parent-stale-recovery-timer",
      wake,
      dispatchedTracker: {
        getWake: () => currentWake,
        clearWake: () => {
          clearWakeCount += 1
        },
        refreshWakeTimer: () => {
          refreshWakeTimerCount += 1
        },
      },
      sessionInspector: {
        hasAssistantOrToolOutputAfterDispatchedWake: async () => {
          currentWake = newerWake
          return "no-output"
        },
        clearActivity: () => {},
      },
      requeueWake: () => {
        requeueWakeCount += 1
      },
      scheduleFlush: () => {
        scheduleFlushCount += 1
      },
    }))

    // then
    expect(clearWakeCount).toBe(0)
    expect(refreshWakeTimerCount).toBe(0)
    expect(requeueWakeCount).toBe(0)
    expect(scheduleFlushCount).toBe(0)
    expect(currentWake).toBe(newerWake)
  })

  test("#given dispatched wake changes during late error history inspection #when requeue resumes #then stale error state is ignored", async () => {
    // given
    const sessionID = "parent-stale-late-error-requeue"
    const sessionMessages: SessionMessageStub[] = [
      {
        info: {
          role: "assistant",
          finish: "stop",
          time: { created: 500 },
        },
      },
    ]
    let notifierRef: ParentWakeNotifier | undefined
    let newerWake: PendingParentWake | undefined
    let replacedDispatchedWake = false
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async () => {
        if (!replacedDispatchedWake && notifierRef) {
          const currentWake = notifierRef.getDispatchedParentWakes().get(sessionID)
          if (currentWake?.dispatchedAt !== undefined) {
            newerWake = {
              ...currentWake,
              notifications: [`${FINAL_WAKE}\nnewer`],
              dispatchedAt: currentWake.dispatchedAt + 1,
            }
            notifierRef.getDispatchedParentWakes().set(sessionID, newerWake)
            replacedDispatchedWake = true
          }
        }
        return { data: sessionMessages }
      },
    })
    notifierRef = notifier
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(true)

      // when
      const requeued = await notifier.requeueDispatchedParentWake(sessionID, "late session.error")

      // then
      expect(requeued).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakes().get(sessionID)).toBe(newerWake)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.notifications).toEqual([
        `${FINAL_WAKE}\nnewer`,
      ])
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given reply retry merges into existing pending wake #when pending queue coalesces #then internal-tail retry metadata is preserved", () => {
    // given
    const queue = new ParentWakePendingQueue({
      pendingRetryMs: 1_000,
      enqueueNotificationForParent: async (_parentSessionID, operation) => {
        await operation()
      },
    })
    const sessionID = "parent-merged-internal-tail-retry"
    queue.queueWake(sessionID, "existing wake", { agent: "sisyphus" }, true)

    try {
      // when
      queue.requeueWake(sessionID, {
        promptContext: { agent: "sisyphus" },
        notifications: [FINAL_WAKE],
        shouldReply: true,
        allowInternalWakeTailRetry: true,
      })

      // then
      expect(queue.getWake(sessionID)?.allowInternalWakeTailRetry).toBe(true)
    } finally {
      queue.shutdown()
    }
  })

  test("#given history inspection fails after the recovery window #when a later inspection sees assistant output #then the dispatched wake is eventually cleared", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionMessagesImpl: async (attempt) => {
        if (attempt === 2) {
          throw new Error("transient history read failure")
        }
        return {
          data: [
            {
              info: {
                role: "assistant",
                finish: "stop",
                time: { created: Date.now() - 10_000 },
              },
            },
            ...(attempt >= 3 ? [{ info: { role: "assistant", finish: "stop", time: { created: Date.now() } } }] : []),
          ] satisfies readonly SessionMessageStub[],
        }
      },
    })
    const sessionID = "parent-window-inspection-retry"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(true)

      // when/then
      await waitUntil(() => !notifier.getDispatchedParentWakes().has(sessionID), 600)
      expect(notifier.getDispatchedParentWakeTimers().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})

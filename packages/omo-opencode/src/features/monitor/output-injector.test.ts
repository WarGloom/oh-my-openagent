import { describe, expect, test } from "bun:test"

import { MonitorOutputInjector } from "./output-injector"
import type { MonitorCounters, MonitorRecord, OutputBatch } from "./types"
import type { InternalPromptDispatchResult, PromptAsyncInput, PromptDispatchClient } from "@oh-my-opencode/utils/prompt-async-gate/types"
import { clearSessionModel, setSessionModel } from "../../shared/session-model-state"

type DispatchCall = {
  source: string
  sessionID: string
  input: PromptAsyncInput
  queueBehavior?: string
  postDispatchHoldMs?: number
  checkStatus?: boolean
  checkToolState?: boolean
}

type ScheduledFlush = {
  monitorId: string
  delayMs: number
  operation: () => Promise<void>
}

type FakeMessage = {
  info?: { role?: string; finish?: string; time?: { created?: unknown } }
  role?: string
  finish?: string
  time?: { created?: unknown }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; content?: unknown; state?: { status?: unknown } }>
}

const baseCounters = {
  totalLines: 1,
  matchedLines: 1,
  unmatchedLines: 0,
  droppedMatched: 0,
  droppedUnmatched: 0,
  bytesDropped: 0,
  lastSequence: 1,
} satisfies MonitorCounters

function createRecord(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: "mon_1",
    command: "printf secret",
    label: "build watcher",
    mode: "idle",
    parentSessionId: "parent-1",
    startedAt: new Date("2026-06-15T00:00:00.000Z"),
    status: "running",
    counters: baseCounters,
    ...overrides,
  }
}

function createBatch(batchSeq: number, text = `line-${batchSeq}`): OutputBatch {
  return {
    monitorId: "mon_1",
    batchSeq,
    lines: [{ stream: "stdout", seq: batchSeq, text }],
    stillRunning: true,
  }
}

function createHarness(opts: {
  active?: boolean
  messages?: FakeMessage[]
  dispatchResults?: InternalPromptDispatchResult[]
  dispatchResult?: () => Promise<InternalPromptDispatchResult>
  dispatchFn?: (source: string) => Promise<InternalPromptDispatchResult>
  settleAfterSessionIdle?: () => Promise<void>
  scheduleFlush?: (monitorId: string, delayMs: number, operation: () => Promise<void>) => void
  now?: number
} = {}): {
  injector: MonitorOutputInjector
  calls: DispatchCall[]
  scheduledFlushes: ScheduledFlush[]
  setActive(active: boolean): void
  setMessages(messages: FakeMessage[]): void
  client: PromptDispatchClient
} {
  let active = opts.active ?? false
  let messages = opts.messages ?? []
  const calls: DispatchCall[] = []
  const scheduledFlushes: ScheduledFlush[] = []
  const dispatchResults = [...opts.dispatchResults ?? []]
  const client = {
    session: {
      status: async () => ({ data: { "parent-1": { type: active ? "busy" : "idle" } } }),
      messages: async () => ({ data: messages }),
      promptAsync: async (_input: PromptAsyncInput) => ({ ok: true }),
    },
  } satisfies PromptDispatchClient & {
    session: {
      status: () => Promise<unknown>
      messages: (input: { path: { id: string }; query: { directory: string; limit?: number } }) => Promise<unknown>
      promptAsync: (input: PromptAsyncInput) => Promise<unknown>
    }
  }

  const injector = new MonitorOutputInjector({
    client,
    directory: "/repo",
    pendingRetryMs: 25,
    acceptedMessageSkewMs: 50,
    userMessageInProgressWindowMs: 500,
    postDispatchHoldMs: 250,
    now: () => opts.now ?? 1_000,
    settleAfterSessionIdle: opts.settleAfterSessionIdle ?? (async () => {}),
    dispatchInternalPrompt: async (args) => {
      calls.push({
        source: args.source,
        sessionID: args.sessionID,
        input: args.input,
        queueBehavior: args.queueBehavior,
        postDispatchHoldMs: args.postDispatchHoldMs,
        checkStatus: args.checkStatus,
        checkToolState: args.checkToolState,
      })
      if (opts.dispatchFn) return opts.dispatchFn(args.source)
      return opts.dispatchResult ? opts.dispatchResult() : dispatchResults.shift() ?? { status: "dispatched", response: { ok: true } }
    },
    scheduleFlush: (monitorId, delayMs, operation) => {
      scheduledFlushes.push({ monitorId, delayMs, operation })
      opts.scheduleFlush?.(monitorId, delayMs, operation)
    },
  })

  return {
    injector,
    calls,
    scheduledFlushes,
    client,
    setActive(nextActive: boolean): void {
      active = nextActive
    },
    setMessages(nextMessages: FakeMessage[]): void {
      messages = nextMessages
    },
  }
}

function latestUserMessage(createdAt: number, text = "real user prompt"): FakeMessage {
  return {
    role: "user",
    time: { created: createdAt },
    parts: [{ type: "text", text }],
  }
}

describe("MonitorOutputInjector", () => {
  test("uses the latest accepted parent model at dispatch rather than at batch queueing", async () => {
    // given
    const record = createRecord()
    const harness = createHarness()
    setSessionModel(record.parentSessionId, { providerID: "provider-a", modelID: "model-a", variant: "variant-a" }, "agent-a")
    harness.injector.queueBatch(record, createBatch(49))
    setSessionModel(record.parentSessionId, { providerID: "provider-b", modelID: "model-b", variant: "variant-b" }, "agent-b")

    // when
    await harness.injector.flushMonitor(record.id)

    // then
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.input.body).toMatchObject({ model: { providerID: "provider-b", modelID: "model-b" }, variant: "variant-b", agent: "agent-b" })
    clearSessionModel(record.parentSessionId)
  })

  test("leaves the existing monitor prompt body alone without a stored selection", async () => {
    // given
    const harness = createHarness()
    const record = createRecord()
    harness.injector.queueBatch(record, createBatch(50))

    // when
    await harness.injector.flushMonitor(record.id)

    // then
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.input.body).not.toHaveProperty("model")
  })

  test("reports terminal delivery while queued and while dispatch is in flight, then releases it", async () => {
    // given
    const terminal = { ...createBatch(9), stillRunning: false }
    const record = createRecord({ status: "exited" })
    const dispatch = Promise.withResolvers<InternalPromptDispatchResult>()
    const dispatchStarted = Promise.withResolvers<void>()
    const { injector } = createHarness({ dispatchResult: () => {
      dispatchStarted.resolve()
      return dispatch.promise
    } })
    injector.queueBatch(record, terminal)
    expect(injector.hasPendingTerminalOutput(record.id)).toBe(true)

    // when
    const flush = injector.flushMonitor(record.id)
    await dispatchStarted.promise
    const duringDispatch = injector.hasPendingTerminalOutput(record.id)
    expect(injector.getPendingBatches(record.id)).toEqual([])
    dispatch.resolve({ status: "dispatched", response: { ok: true } })
    await flush

    // then
    expect(injector.getPendingBatches(record.id)).toEqual([])
    expect(duringDispatch).toBe(true)
    expect(injector.hasPendingTerminalOutput(record.id)).toBe(false)
  })

  describe("#given an idle-mode batch while the parent session is active", () => {
    test("#when flushing #then it does not dispatch and keeps the same batch pending", async () => {
      // given
      const record = createRecord({ mode: "idle" })
      const batch = createBatch(1)
      const { injector, calls } = createHarness({ active: true })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(0)
      expect(injector.getPendingBatches(record.id)).toEqual([batch])
      expect(injector.getPendingBatches(record.id)[0]).toBe(batch)
    })
  })

  describe("#given an active batch that later becomes idle", () => {
    test("#when flushing after idle #then it dispatches once with the monitor batch idempotency source", async () => {
      // given
      const record = createRecord({ mode: "idle" })
      const batch = createBatch(2)
      const harness = createHarness({ active: true })
      harness.injector.queueBatch(record, batch)
      await harness.injector.flushMonitor(record.id)
      harness.setActive(false)

      // when
      await harness.injector.flushMonitor(record.id)

      // then
      expect(harness.calls).toHaveLength(1)
      expect(harness.calls[0]?.source).toBe("monitor-output:mon_1:batch-2")
      expect(harness.calls[0]?.queueBehavior).toBe("defer")
      expect(harness.calls[0]?.postDispatchHoldMs).toBeGreaterThan(0)
      expect(harness.calls[0]?.checkStatus).toBe(true)
      expect(harness.calls[0]?.checkToolState).toBe(true)
      expect(harness.injector.getPendingBatches(record.id)).toEqual([])
    })
  })

  describe("#given the same batch sequence is queued twice", () => {
    test("#when flushing with a new sequence afterward #then duplicate seq collapses and new seq dispatches separately", async () => {
      // given
      const record = createRecord()
      const first = createBatch(3)
      const duplicate = createBatch(3, "duplicate")
      const second = createBatch(4)
      const { injector, calls } = createHarness()
      injector.queueBatch(record, first)
      await injector.flushMonitor(record.id)

      // when
      injector.queueBatch(record, duplicate)
      injector.queueBatch(record, second)
      await injector.flushMonitor(record.id)

      // then
      expect(calls.map((call) => call.source)).toEqual([
        "monitor-output:mon_1:batch-3",
        "monitor-output:mon_1:batch-4",
      ])
    })
  })

  describe("#given a real user message races the monitor flush", () => {
    test("#when the latest real user message is recent #then user wins and the monitor batch is requeued", async () => {
      // given
      const record = createRecord()
      const batch = createBatch(5)
      const { injector, calls } = createHarness({ messages: [latestUserMessage(900)], now: 1_000 })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(0)
      expect(injector.getPendingBatches(record.id)[0]).toBe(batch)
    })
  })

  describe("#given live_safe mode while the parent session is active", () => {
    test("#when flushing #then it still defers instead of bypassing the active-session guard", async () => {
      // given
      const record = createRecord({ mode: "live_safe" })
      const batch = createBatch(6)
      const { injector, calls } = createHarness({ active: true })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(0)
      expect(injector.getPendingBatches(record.id)[0]).toBe(batch)
    })
  })

  describe("#given dispatch fails ambiguously after OpenCode may have accepted the message", () => {
    test("#when session history contains the accepted monitor message #then it does not double-inject", async () => {
      // given
      const record = createRecord()
      const batch = createBatch(7)
      const acceptedText = "[OMO MONITOR OUTPUT]\nmonitor_id: mon_1\nbatch: 7\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->"
      const { injector, calls } = createHarness({
        dispatchResults: [{ status: "failed", error: new Error("unexpected eof"), dispatchAttempted: true }],
        messages: [{ role: "user", time: { created: 1_000 }, parts: [{ type: "text", text: acceptedText }] }],
        now: 1_000,
      })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)
      injector.queueBatch(record, batch)
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(1)
      expect(injector.getPendingBatches(record.id)).toEqual([])
    })
  })

  describe("#given dev's prompt-async-gate blocks trailing non-no-reply internal user messages", () => {
    test("#when a batch dispatches #then the injected message text carries the internal no-reply marker", async () => {
      // given
      const record = createRecord()
      const batch = createBatch(11)
      const { injector, calls } = createHarness({})
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0]?.input ?? {})).toContain("OMO_INTERNAL_NOREPLY")
    })

    test("#when a prior no-reply monitor message is the latest history entry #then a fresh batch is NOT blocked", async () => {
      // given
      const record = createRecord()
      const priorNoReplyMonitorMessage = {
        role: "user",
        time: { created: 900 },
        parts: [{ type: "text", text: "[OMO MONITOR OUTPUT]\nmonitor_id: mon_1\nbatch: 1\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->" }],
      }
      const batch = createBatch(12)
      const { injector, calls } = createHarness({ messages: [priorNoReplyMonitorMessage], now: 1_000 })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(1)
    })
  })

  describe("#given the prompt gate returns a non-accepted result", () => {
    test("#when the same batch is retried after reservation #then the same batch object is requeued without changing sequence", async () => {
      // given
      const record = createRecord()
      const batch = createBatch(8)
      const { injector, calls } = createHarness({
        dispatchResults: [
          { status: "reserved", reservedBy: "other-route" },
          { status: "dispatched", response: { ok: true } },
        ],
      })
      injector.queueBatch(record, batch)

      // when
      await injector.flushMonitor(record.id)
      const pendingAfterReserve = injector.getPendingBatches(record.id)[0]
      await injector.flushMonitor(record.id)

      // then
      expect(pendingAfterReserve).toBe(batch)
      expect(calls.map((call) => call.source)).toEqual([
        "monitor-output:mon_1:batch-8",
        "monitor-output:mon_1:batch-8",
      ])
    })
  })

  describe("#given a streaming batch and an empty terminal batch flushed by overlapping callers", () => {
    test("#when the terminal batch is first reserved by the in-flight streaming dispatch #then it is still delivered once as a reply-producing prompt", async () => {
      // given
      const streamingSource = "monitor-output:mon_1:batch-1"
      const terminalSource = "monitor-output:mon_1:batch-2"
      let releaseStreamingDispatch: (() => void) | undefined
      let terminalAttempts = 0
      const { injector, calls } = createHarness({
        dispatchFn: async (source) => {
          if (source === streamingSource) {
            await new Promise<void>((resolve) => {
              releaseStreamingDispatch = resolve
            })
            return { status: "dispatched", response: { ok: true } }
          }
          terminalAttempts += 1
          return terminalAttempts === 1
            ? { status: "reserved", reservedBy: streamingSource }
            : { status: "dispatched", response: { ok: true } }
        },
      })
      const runningRecord = createRecord()
      const exitedRecord = createRecord({ status: "exited", exitCode: 0 })
      const terminalBatch: OutputBatch = { monitorId: "mon_1", batchSeq: 2, lines: [], stillRunning: false }

      // when
      injector.queueBatch(runningRecord, createBatch(1, "RERUN DONE"))
      const timerFlush = injector.flushMonitor(runningRecord.id)
      for (let attempt = 0; attempt < 20 && !releaseStreamingDispatch; attempt += 1) {
        await Promise.resolve()
      }
      injector.queueBatch(exitedRecord, terminalBatch)
      const exitFlush = injector.flushMonitor(exitedRecord.id)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve()
      }
      releaseStreamingDispatch?.()
      await Promise.all([timerFlush, exitFlush])
      await injector.flushMonitor(exitedRecord.id)

      // then
      const streamingCalls = calls.filter((call) => call.source === streamingSource)
      const terminalCalls = calls.filter((call) => call.source === terminalSource)
      expect(streamingCalls).toHaveLength(1)
      expect(streamingCalls[0]?.input.body.noReply).toBe(true)
      expect(terminalCalls).toHaveLength(2)
      expect(terminalCalls.every((call) => call.input.body.noReply === false)).toBe(true)
      expect(injector.getPendingBatches(runningRecord.id)).toEqual([])
      expect(injector.hasPendingTerminalOutput(runningRecord.id)).toBe(false)
    })
  })

  describe("#given a flush attempt throws while a second caller coalesces onto it", () => {
    test("#when the in-flight flush rejects #then a retry is scheduled and the terminal batch is delivered once as a reply-producing prompt", async () => {
      // given
      let settleCalls = 0
      let failFirstSettle: (() => void) | undefined
      const { injector, calls, scheduledFlushes } = createHarness({
        settleAfterSessionIdle: async () => {
          settleCalls += 1
          if (settleCalls === 1) {
            await new Promise<void>((resolve) => {
              failFirstSettle = resolve
            })
            throw new Error("settle failed")
          }
        },
      })
      const exitedRecord = createRecord({ status: "exited", exitCode: 0 })
      injector.queueBatch(exitedRecord, { monitorId: "mon_1", batchSeq: 2, lines: [], stillRunning: false })
      scheduledFlushes.length = 0

      // when
      const exitFlush = injector.flushMonitor(exitedRecord.id)
      for (let attempt = 0; attempt < 20 && !failFirstSettle; attempt += 1) {
        await Promise.resolve()
      }
      const timerFlush = injector.flushMonitor(exitedRecord.id)
      failFirstSettle?.()
      const outcomes = await Promise.allSettled([exitFlush, timerFlush])
      const retry = scheduledFlushes.find((entry) => entry.monitorId === exitedRecord.id)
      await retry?.operation()

      // then
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
      expect(retry?.delayMs).toBe(25)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.source).toBe("monitor-output:mon_1:batch-2")
      expect(calls[0]?.input.body.noReply).toBe(false)
      expect(injector.hasPendingTerminalOutput(exitedRecord.id)).toBe(false)
    })
  })

  describe("#given a scheduler that invokes the flush operation synchronously", () => {
    test("#when the parent stays active #then coalesced reruns are capped and the flush settles without dispatching", async () => {
      // given
      const { injector, calls, scheduledFlushes } = createHarness({
        active: true,
        scheduleFlush: (_monitorId, _delayMs, operation) => {
          void operation().catch(() => {})
        },
      })
      const record = createRecord()

      // when
      injector.queueBatch(record, createBatch(1))
      await injector.flushMonitor(record.id)

      // then
      expect(calls).toHaveLength(0)
      expect(scheduledFlushes.length).toBeLessThan(20)
      expect(injector.getPendingBatches(record.id)).toHaveLength(1)
    })
  })
})

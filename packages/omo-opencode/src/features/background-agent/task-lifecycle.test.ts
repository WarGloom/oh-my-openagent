import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  bindAttemptSession,
  ensureCurrentAttempt,
  finalizeAttempt,
  scheduleRetryAttempt,
  startAttempt,
} from "./attempt-lifecycle"
import { subscribeTaskLifecycle, type TaskLifecycleEvent } from "./task-lifecycle"
import { tryFallbackRetry } from "./fallback-retry-handler"
import { ConcurrencyManager } from "./concurrency"
import type { BackgroundTask } from "./types"
import { backgroundTaskRecord, encodeBackgroundTask } from "../../v2/background-task-record"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundManager } from "./manager"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import * as ledger from "../../tools/delegate-task/jev-routing-ledger"

let ledgerSpy: ReturnType<typeof spyOn>
beforeEach(() => {
  ledgerSpy = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
})
afterEach(() => {
  ledgerSpy.mockRestore()
})

function task(): BackgroundTask {
  return {
    id: "bg_lifecycle",
    decisionId: randomUUID(),
    parentSessionId: "parent",
    parentMessageId: "message",
    description: "task",
    prompt: "private prompt",
    agent: "worker",
    status: "pending",
    attemptCount: 0,
    model: { providerID: "test", modelID: "first" },
  }
}

test("attempts keep one decision across replacement and persist unresolved state without replay", () => {
  const record = task()
  const events: TaskLifecycleEvent[] = []
  const unsubscribe = subscribeTaskLifecycle((event) => {
    if (event.decisionId === record.decisionId) events.push(event)
  })
  try {
    const first = startAttempt(record, record.model)
    bindAttemptSession(record, first.attemptId, "child-first", record.model)
    const second = scheduleRetryAttempt(record, first.attemptId, { providerID: "test", modelID: "second" })
    expect(second).toBeDefined()
    if (!second) throw new Error("Missing replacement")
    bindAttemptSession(record, second.attemptId, "child-second", record.model)
    const restored = backgroundTaskRecord.parse(encodeBackgroundTask(record))
    const before = events.length
    ensureCurrentAttempt(restored)
    expect(events).toHaveLength(before)
    expect(restored.decisionId).toBe(record.decisionId)
    expect(events.filter((event) => event.event === "outcome")).toEqual([
      expect.objectContaining({ attemptId: first.attemptId, status: "failed" }),
    ])
    expect(events.filter((event) => event.event === "attempt").map((event) => event.attemptId)).toEqual([
      first.attemptId,
      first.attemptId,
      second.attemptId,
      second.attemptId,
    ])
    expect(events.at(-1)).toMatchObject({
      cause: "fallback_replacement",
      childSessionId: "child-second",
      resolvedModel: "test/second",
    })
    record.result = "complete"
    record.producingModel = "test/actual"
    finalizeAttempt(record, second.attemptId, "completed")
    finalizeAttempt(record, second.attemptId, "completed")
    expect(events.filter((event) => event.event === "outcome")).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ status: "completed", producingModel: "test/actual" })
  } finally {
    unsubscribe()
  }
})

test.each(["retry", "fallback_replacement"] as const)(
  "%s creates a new attempt instead of rewriting the failed attempt",
  async (cause) => {
    const record = task()
    record.fallbackChain = [{ providers: ["test"], model: "second" }]
    const first = startAttempt(record, record.model)
    bindAttemptSession(record, first.attemptId, "child", record.model)
    const startedAt = new Date("2026-01-01T00:00:00Z")
    record.startedAt = startedAt
    const retried = await tryFallbackRetry({
      task: record,
      errorInfo: { statusCode: 429, message: "rate limit" },
      source: "test",
      concurrencyManager: new ConcurrencyManager({}),
      client: { session: { abort: async () => ({}) } },
      idleDeferralTimers: new Map(),
      queuesByKey: new Map(),
      processKey: () => {},
      onSameSessionRetry: cause === "retry" ? async () => true : undefined,
      deps: {
        readProviderModelsCache: () => null,
        readConnectedProvidersCache: () => ["test"],
        shouldRetryError: () => true,
        hasMoreFallbacks: () => true,
        getNextFallback: () => ({ providers: ["test"], model: "second" }),
        selectFallbackProvider: () => "test",
        transformModelForProvider: (_provider, model) => model,
      },
    })
    expect(retried).toBe(true)
    expect(record.attempts).toHaveLength(2)
    expect(record.attempts?.[0]).toMatchObject({ attemptId: first.attemptId, modelId: "first", status: "error" })
    expect(record.attempts?.[1]).toMatchObject({
      cause,
      modelId: "second",
      status: cause === "retry" ? "running" : "pending",
    })
    expect(record.attempts?.[1]?.sessionId).toBe(cause === "retry" ? "child" : undefined)
    expect(record.currentAttemptID).not.toBe(first.attemptId)
    if (cause === "retry") {
      expect(record.startedAt).toBe(startedAt)
      expect(record.attempts?.[1]?.startedAt).toBe(startedAt)
    }
  },
)

test("startAttempt preserves existing result semantics without a routing decision", () => {
  const record = task()
  delete record.decisionId
  record.result = "Previous result"
  record.producingModel = "test/previous"
  startAttempt(record, record.model)
  expect(record.result).toBe("Previous result")
  expect(record.producingModel).toBe("test/previous")
})

test("legacy background launch owns the decision and emits its bound attempt and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-legacy-"))
  const decisionId = randomUUID()
  const bound = Promise.withResolvers<void>()
  const events: TaskLifecycleEvent[] = []
  const unsubscribe = subscribeTaskLifecycle((event) => {
    if (event.decisionId !== decisionId) return
    events.push(event)
    if (event.event === "attempt" && event.childSessionId === "child") bound.resolve()
  })
  const manager = new BackgroundManager({
    enableParentSessionNotifications: false,
    pluginContext: unsafeTestValue({
      directory,
      client: {
        session: {
          get: async () => ({ data: { directory } }),
          create: async () => ({ data: { id: "child" } }),
          promptAsync: async () => ({ data: {} }),
          abort: async () => ({ data: {} }),
          status: async () => ({ data: { child: { type: "busy" } } }),
          messages: async () => ({ data: [] }),
        },
      },
    }),
  })
  try {
    const launched = await manager.launch({
      decisionId,
      parentSessionId: "parent",
      parentMessageId: "message",
      description: "Task",
      prompt: "Private prompt",
      agent: "worker",
      model: { providerID: "test", modelID: "model" },
    })
    await bound.promise
    expect(manager.getTask(launched.id)?.decisionId).toBe(decisionId)
    await manager.cancelTask(launched.id, { source: "test", skipNotification: true })
    expect(events.filter((event) => event.event === "attempt").map((event) => event.childSessionId)).toEqual([
      null,
      "child",
    ])
    expect(events.at(-1)).toMatchObject({ event: "outcome", decisionId, taskId: launched.id, status: "cancelled" })
  } finally {
    unsubscribe()
    await manager.shutdown()
    rmSync(directory, { recursive: true, force: true })
  }
})

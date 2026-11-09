import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { bindAttemptSession, finalizeAttempt, startAttempt } from "./attempt-lifecycle"
import { captureTaskTerminalEvidence, TERMINAL_EVIDENCE_TIMEOUT_MS } from "./task-terminal-evidence"
import { subscribeTaskLifecycle, type TaskLifecycleEvent } from "./task-lifecycle"
import type { BackgroundTask } from "./types"
import * as ledger from "../../tools/delegate-task/jev-routing-ledger"
import { bindNativeSdkStorage } from "../../shared/opencode-storage-detection"

let recordSpy: ReturnType<typeof spyOn>
beforeEach(() => {
  recordSpy = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
})
afterEach(() => {
  recordSpy.mockRestore()
})

test("native terminal telemetry uses receipt evidence instead of loading full context", async () => {
  const messages = mock(async () => {
    throw new Error("Full context must not be loaded")
  })
  const client = { session: { messages } }
  bindNativeSdkStorage(client)
  expect(await captureTaskTerminalEvidence("native-child", client)).toEqual({})
  expect(messages).not.toHaveBeenCalled()
})

test("terminal evidence times out and cancels a limited read without holding task completion", async () => {
  const originalTimer = globalThis.setTimeout.bind(globalThis)
  const expired = Promise.withResolvers<() => void>()
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
    const timer = originalTimer(handler, timeout, ...args)
    if (timeout === TERMINAL_EVIDENCE_TIMEOUT_MS) expired.resolve(() => handler(...args))
    return timer
  })
  const task: BackgroundTask = {
    id: "bg_timeout",
    decisionId: crypto.randomUUID(),
    parentSessionId: "parent",
    parentMessageId: "message",
    description: "Task",
    prompt: "Private",
    agent: "worker",
    status: "pending",
  }
  const first = startAttempt(task, { providerID: "test", modelID: "selected" })
  bindAttemptSession(task, first.attemptId, "child", task.model)
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const messages = async (input: {
    path: { id: string }
    query?: { limit: number }
    signal?: AbortSignal
  }): Promise<unknown> => {
    expect(input.query?.limit).toBe(2)
    entered.resolve(input.signal)
    return new Promise(() => {})
  }
  const outcome = Promise.withResolvers<TaskLifecycleEvent>()
  const unsubscribe = subscribeTaskLifecycle((event) => {
    if (event.decisionId === task.decisionId && event.event === "outcome") outcome.resolve(event)
  })
  try {
    const evidence = captureTaskTerminalEvidence("child", { session: { messages } })
    finalizeAttempt(task, first.attemptId, "completed", undefined, evidence)
    expect(task.status).toBe("completed")
    const signal = await entered.promise
    const expire = await expired.promise
    expire()
    expect(signal?.aborted).toBe(true)
    expect(await outcome.promise).toMatchObject({
      event: "outcome",
      attemptId: first.attemptId,
      status: "completed",
      producingModel: null,
    })
  } finally {
    unsubscribe()
    timeoutSpy.mockRestore()
  }
})

test("late evidence cannot relabel another attempt or mutate its operational task", async () => {
  const task: BackgroundTask = {
    id: "bg_late",
    decisionId: crypto.randomUUID(),
    parentSessionId: "parent",
    parentMessageId: "message",
    description: "Task",
    prompt: "Private",
    agent: "worker",
    status: "pending",
  }
  const first = startAttempt(task, { providerID: "test", modelID: "first" })
  bindAttemptSession(task, first.attemptId, "child-first", task.model)
  task.result = "Original result"
  const response = Promise.withResolvers<unknown>()
  const evidence = captureTaskTerminalEvidence("child-first", { session: { messages: async () => response.promise } })
  const outcome = Promise.withResolvers<TaskLifecycleEvent>()
  const unsubscribe = subscribeTaskLifecycle((event) => {
    if (event.decisionId === task.decisionId && event.event === "outcome") outcome.resolve(event)
  })
  try {
    finalizeAttempt(task, first.attemptId, "completed", undefined, evidence)
    const second = startAttempt(task, { providerID: "test", modelID: "second" }, "continuation")
    bindAttemptSession(task, second.attemptId, "child-second", task.model)
    const snapshot = structuredClone(task)
    response.resolve({
      data: [
        {
          info: { role: "assistant", providerID: "test", modelID: "wrong-late-model" },
          parts: [{ type: "text", text: "Wrong result" }],
        },
      ],
    })
    expect(await outcome.promise).toMatchObject({
      attemptId: first.attemptId,
      childSessionId: "child-first",
      producingModel: null,
      output: "Original result",
    })
    expect(task).toEqual(snapshot)
  } finally {
    unsubscribe()
  }
})

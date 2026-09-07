import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { TASK_CLEANUP_DELAY_MS } from "./constants"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { executeSyncContinuation } from "../../tools/delegate-task/sync-continuation"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: {
    directory: string
  }
}

type SessionMessageForTest = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number }
  }
  parts?: Array<{ type?: string; state?: { status?: string } }>
}

type FakeTimers = {
  getDelay: (timer: ReturnType<typeof setTimeout>) => number | undefined
  capture: (timer: ReturnType<typeof setTimeout>) => () => Promise<void>
  run: (timer: ReturnType<typeof setTimeout>) => Promise<void>
  advanceBy: (ms: number) => Promise<void>
  runNext: () => Promise<boolean>
  restore: () => void
}

type PendingParentWakeForTest = {
  promptContext?: Record<string, unknown>
  notifications: string[]
  shouldReply: boolean
  toolCallDeferralStartedAt?: number
}

let managerUnderTest: BackgroundManager | undefined
let fakeTimers: FakeTimers | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  fakeTimers?.restore()
  releaseAllPromptAsyncReservationsForTesting()
  managerUnderTest = undefined
  fakeTimers = undefined
})

function createTask(overrides: Partial<BackgroundTask> & { id: string; parentSessionId: string }): BackgroundTask {
  const id = overrides.id
  const parentSessionID = overrides.parentSessionId
  const { id: _ignoredID, parentSessionId: _ignoredParentSessionID, ...rest } = overrides

  return {
    parentMessageId: overrides.parentMessageId ?? "parent-message-id",
    description: overrides.description ?? overrides.id,
    prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
    agent: overrides.agent ?? "test-agent",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date("2026-03-11T00:00:00.000Z"),
    ...rest,
    id,
    parentSessionId: parentSessionID,
  }
}

function createManager(
  enableParentSessionNotifications: boolean,
  sessionStatuses?: Record<string, { type: string }>,
  promptAsyncImpl?: (call: PromptAsyncCall) => Promise<unknown>,
  sessionMessages?: SessionMessageForTest[],
): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
}
function createManager(
  enableParentSessionNotifications: boolean,
  sessionStatuses?: Record<string, { type: string }>,
  promptAsyncImpl?: (call: PromptAsyncCall) => Promise<unknown>,
  sessionMessages: SessionMessageForTest[] = [],
): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
} {
  if (enableParentSessionNotifications && !fakeTimers) {
    fakeTimers = installFakeTimers()
  }

  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => sessionMessages,
      status: async () => ({ data: sessionStatuses ?? {} }),
      prompt: async () => ({}),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        if (promptAsyncImpl) {
          return promptAsyncImpl(call)
        }
        return {}
      },
      abort: async () => ({}),
    },
  }
  const ctx: PluginInput = {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
    experimental_workspace: { register: () => {} },
  }

  const manager = new BackgroundManager(
    { pluginContext: ctx, config: undefined, enableParentSessionNotifications }
  )

  return { manager, promptAsyncCalls }
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalDateNow = Date.now
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void | Promise<void>>()
  const delays = new Map<ReturnType<typeof setTimeout>, number>()
  const dueTimes = new Map<ReturnType<typeof setTimeout>, number>()
  let now = Date.now()

  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") {
      throw new Error("Expected function timeout handler")
    }

    const timer = originalSetTimeout(() => {}, 60_000)
    originalClearTimeout(timer)
    const callback = handler as (...callbackArgs: Array<unknown>) => void
    callbacks.set(timer, () => callback(...args))
    const normalizedDelay = Math.max(0, delay ?? 0)
    delays.set(timer, normalizedDelay)
    dueTimes.set(timer, now + normalizedDelay)
    return timer
  }) as typeof setTimeout

  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>): void => {
    callbacks.delete(timer)
    delays.delete(timer)
    dueTimes.delete(timer)
  }) as typeof clearTimeout
  Date.now = () => now

  return {
    getDelay(timer) {
      return delays.get(timer)
    },
    capture(timer) {
      const callback = callbacks.get(timer)
      if (!callback) {
        throw new Error(`Timer not found: ${String(timer)}`)
      }
      return async () => {
        await callback()
        await flushMicrotasks()
      }
    },
    async run(timer) {
      const callback = callbacks.get(timer)
      if (!callback) {
        throw new Error(`Timer not found: ${String(timer)}`)
      }

      now = dueTimes.get(timer) ?? now
      callbacks.delete(timer)
      delays.delete(timer)
      dueTimes.delete(timer)
      await callback()
      await flushMicrotasks()
    },
    async advanceBy(ms) {
      const target = now + ms
      while (true) {
        const nextTimer = nextTimerDueBefore(target)
        if (!nextTimer) break
        await this.run(nextTimer)
      }
      now = target
      await flushMicrotasks()
    },
    async runNext() {
      const nextTimer = nextTimerDueBefore(Number.POSITIVE_INFINITY)
      if (!nextTimer) {
        await flushMicrotasks()
        return false
      }
      await this.run(nextTimer)
      return true
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      Date.now = originalDateNow
    },
  }

  function nextTimerDueBefore(target: number): ReturnType<typeof setTimeout> | undefined {
    return [...dueTimes.entries()]
      .filter(([, dueAt]) => dueAt <= target)
      .sort((left, right) => left[1] - right[1])[0]?.[0]
  }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

function getPendingNotifications(manager: BackgroundManager): Map<string, string[]> {
  return Reflect.get(manager, "pendingNotifications") as Map<string, string[]>
}

function getPendingParentWakes(manager: BackgroundManager): Map<string, PendingParentWakeForTest> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakes: () => Map<string, PendingParentWakeForTest>
  }
  return parentWakeNotifier.getPendingParentWakes()
}

function getPendingParentWakeTimers(manager: BackgroundManager): Map<string, ReturnType<typeof setTimeout>> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakeTimers: () => Map<string, ReturnType<typeof setTimeout>>
  }
  return parentWakeNotifier.getPendingParentWakeTimers()
}

function getCompletionTimers(manager: BackgroundManager): Map<string, ReturnType<typeof setTimeout>> {
  return Reflect.get(manager, "completionTimers") as Map<string, ReturnType<typeof setTimeout>>
}

async function notifyParentSessionForTest(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (task: BackgroundTask) => Promise<void>
  return notifyParentSession.call(manager, task)
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

async function flushParentWake(manager: BackgroundManager, sessionID = "parent-1"): Promise<void> {
  if (!fakeTimers) {
    throw new Error("Fake timers must be installed before flushing parent wakes")
  }

  const pendingTimer = getPendingParentWakeTimers(manager).get(sessionID)
  if (pendingTimer) {
    await fakeTimers.run(pendingTimer)
  } else {
    const flushPendingParentWake = Reflect.get(manager, "flushPendingParentWake") as (id: string) => Promise<void>
    void flushPendingParentWake.call(manager, sessionID)
    await flushMicrotasks()
  }

  await fakeTimers.advanceBy(151)
}

async function waitForDeferredWake(manager: BackgroundManager, promptAsyncCalls: PromptAsyncCall[]): Promise<void> {
  if (!fakeTimers) {
    throw new Error("Fake timers must be installed before waiting for parent wakes")
  }

  for (let attempts = 0; attempts < 12 && promptAsyncCalls.length === 0; attempts += 1) {
    await flushParentWake(manager)
    if (promptAsyncCalls.length > 0) break
    await fakeTimers.runNext()
  }
}

async function waitForRequeuedParentWake(manager: BackgroundManager, sessionID: string): Promise<void> {
  if (!fakeTimers) {
    throw new Error("Fake timers must be installed before waiting for parent wakes")
  }

  for (let attempts = 0; attempts < 12 && (getPendingParentWakes(manager).get(sessionID)?.notifications.length ?? 0) === 0; attempts += 1) {
    await flushParentWake(manager, sessionID)
    if ((getPendingParentWakes(manager).get(sessionID)?.notifications.length ?? 0) > 0) break
    await fakeTimers.runNext()
  }
}

function waitForCoalescedFlush(manager: BackgroundManager, promptAsyncCalls: PromptAsyncCall[]): Promise<void> {
  return waitForDeferredWake(manager, promptAsyncCalls)
}

function getRequiredTimer(manager: BackgroundManager, taskID: string): ReturnType<typeof setTimeout> {
  const timer = getCompletionTimers(manager).get(taskID)
  expect(timer).toBeDefined()
  if (timer === undefined) {
    throw new Error(`Missing completion timer for ${taskID}`)
  }

  return timer
}

describe("BackgroundManager.notifyParentSession cleanup scheduling", () => {
  describe("#given 3 tasks for same parent and task A completed first", () => {
    test("#when siblings are still running or pending #then task A remains until siblings also complete", async () => {
      // given
      const { manager } = createManager(false)
      managerUnderTest = manager
      fakeTimers = installFakeTimers()
      const taskA = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date() })
      const taskB = createTask({ id: "task-b", parentSessionId: "parent-1", description: "task B", status: "running" })
      const taskC = createTask({ id: "task-c", parentSessionId: "parent-1", description: "task C", status: "pending" })
      getTasks(manager).set(taskA.id, taskA)
      getTasks(manager).set(taskB.id, taskB)
      getTasks(manager).set(taskC.id, taskC)
      getPendingByParent(manager).set(taskA.parentSessionId, new Set([taskA.id, taskB.id, taskC.id]))

      // when
      await notifyParentSessionForTest(manager, taskA)
      const taskATimer = getRequiredTimer(manager, taskA.id)
      expect(fakeTimers.getDelay(taskATimer)).toBe(TASK_CLEANUP_DELAY_MS)
      await fakeTimers.run(taskATimer)

      // then
      expect(fakeTimers.getDelay(taskATimer)).toBeUndefined()
      expect(getTasks(manager).has(taskA.id)).toBe(true)
      expect(getTasks(manager).get(taskB.id)).toBe(taskB)
      expect(getTasks(manager).get(taskC.id)).toBe(taskC)

      // when
      taskB.status = "completed"
      taskB.completedAt = new Date()
      taskC.status = "completed"
      taskC.completedAt = new Date()
      await notifyParentSessionForTest(manager, taskB)
      await notifyParentSessionForTest(manager, taskC)
      const rescheduledTaskATimer = getRequiredTimer(manager, taskA.id)
      expect(fakeTimers.getDelay(rescheduledTaskATimer)).toBe(TASK_CLEANUP_DELAY_MS)
      await fakeTimers.run(rescheduledTaskATimer)

      // then
      expect(getTasks(manager).has(taskA.id)).toBe(false)
    })
  })

  describe("#given background tasks for same parent", () => {
    test("#when two completions arrive back-to-back while parent is idle #then one batched notification is sent with both tasks", async () => {
      // given
      const { manager, promptAsyncCalls } = createManager(true)
      managerUnderTest = manager
      const taskA = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      const taskB = createTask({ id: "task-b", parentSessionId: "parent-1", description: "task B", status: "running" })
      getTasks(manager).set(taskA.id, taskA)
      getTasks(manager).set(taskB.id, taskB)
      getPendingByParent(manager).set(taskA.parentSessionId, new Set([taskA.id, taskB.id]))

      await notifyParentSessionForTest(manager, taskA)
      taskB.status = "completed"
      taskB.completedAt = new Date("2026-03-11T00:02:00.000Z")

      // when
      await notifyParentSessionForTest(manager, taskB)
      await waitForCoalescedFlush(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      const batchedCall = promptAsyncCalls[0]
      if (!batchedCall) {
        throw new Error("Missing batched notification call")
      }
      expect(batchedCall.body.noReply).toBe(false)
      const batchedPayload = JSON.stringify(batchedCall.body.parts)
      expect(batchedPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(batchedPayload).toContain(OMO_INTERNAL_INITIATOR_MARKER)
      expect(batchedPayload).toContain(taskA.id)
      expect(batchedPayload).toContain(taskB.id)
      expect(batchedPayload).toContain(taskA.description)
      expect(batchedPayload).toContain(taskB.description)
    })

    test("#when many completions arrive in rapid succession while parent is idle #then a single coalesced notification is sent", async () => {
      // given
      const { manager, promptAsyncCalls } = createManager(true)
      managerUnderTest = manager
      const taskIds = ["task-1", "task-2", "task-3", "task-4", "task-5"]
      const tasks = taskIds.map((id, index) => createTask({
        id,
        parentSessionId: "parent-1",
        description: `description ${id}`,
        status: "completed",
        completedAt: new Date(`2026-03-11T00:01:0${index}.000Z`),
      }))
      for (const task of tasks) {
        getTasks(manager).set(task.id, task)
      }
      getPendingByParent(manager).set("parent-1", new Set(taskIds))

      // when
      for (const task of tasks) {
        await notifyParentSessionForTest(manager, task)
      }
      await waitForCoalescedFlush(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      const batchedCall = promptAsyncCalls[0]
      if (!batchedCall) {
        throw new Error("Missing batched notification call")
      }
      expect(batchedCall.body.noReply).toBe(false)
      const batchedPayload = JSON.stringify(batchedCall.body.parts)
      expect(batchedPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      for (const task of tasks) {
        expect(batchedPayload).toContain(task.id)
        expect(batchedPayload).toContain(task.description)
      }
    })

    test("#when parent session is busy #then all-complete notification does not start an overlapping parent reply", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      // when
      await notifyParentSessionForTest(manager, task)

      // then
      expect(promptAsyncCalls).toHaveLength(0)
    })

    test("#when partial completion arrives while parent session is busy #then notification waits until idle without waking a reply", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const taskA = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      const taskB = createTask({ id: "task-b", parentSessionId: "parent-1", description: "task B", status: "running" })
      getTasks(manager).set(taskA.id, taskA)
      getTasks(manager).set(taskB.id, taskB)
      getPendingByParent(manager).set(taskA.parentSessionId, new Set([taskA.id, taskB.id]))

      // when
      await notifyParentSessionForTest(manager, taskA)

      // then
      expect(promptAsyncCalls).toHaveLength(0)

      // when
      sessionStatuses["parent-1"] = { type: "idle" }
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("BACKGROUND TASK RESULT READY")
      expect(notificationPayload).not.toContain("ALL BACKGROUND TASKS COMPLETE")
    })

    test("#when partial and all-complete notifications queue while parent session is busy #then idle flushes one reply wake", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const taskA = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      const taskB = createTask({ id: "task-b", parentSessionId: "parent-1", description: "task B", status: "running" })
      getTasks(manager).set(taskA.id, taskA)
      getTasks(manager).set(taskB.id, taskB)
      getPendingByParent(manager).set(taskA.parentSessionId, new Set([taskA.id, taskB.id]))

      await notifyParentSessionForTest(manager, taskA)
      taskB.status = "completed"
      taskB.completedAt = new Date("2026-03-11T00:02:00.000Z")

      // when
      await notifyParentSessionForTest(manager, taskB)

      // then
      expect(promptAsyncCalls).toHaveLength(0)

      // when
      sessionStatuses["parent-1"] = { type: "idle" }
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("BACKGROUND TASK COMPLETED")
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(notificationPayload).toContain(taskA.id)
      expect(notificationPayload).toContain(taskB.id)
    })

    test("#when retry no-reply notification batches with final completion #then idle flush sends one reply wake", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const queuePendingParentWake = Reflect.get(manager, "queuePendingParentWake") as (
        sessionID: string,
        notification: string,
        promptContext: Record<string, unknown>,
        shouldReply: boolean,
        delayMs?: number,
      ) => void
      queuePendingParentWake.call(
        manager,
        "parent-1",
        "<system-reminder>\n[BACKGROUND TASK RETRYING]\n</system-reminder>",
        {},
        false,
        0,
      )
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        description: "task A",
        status: "completed",
        completedAt: new Date("2026-03-11T00:02:00.000Z"),
      })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      // when
      await notifyParentSessionForTest(manager, task)
      sessionStatuses["parent-1"] = { type: "idle" }
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("BACKGROUND TASK RETRYING")
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
    })

    test("#when parent status is idle but latest assistant turn is still waiting on tool results #then background completion records a no-reply wake", async () => {
      // given
      const originalDateNow = Date.now
      Date.now = () => 1778820000000
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "idle" },
      }
      const sessionMessages: SessionMessageForTest[] = [
        {
          info: { role: "user", time: { created: 1778819814009 } },
          parts: [{ type: "text" }],
        },
        {
          info: { role: "assistant", finish: "tool-calls", time: { created: 1778819997535 } },
          parts: [{ type: "tool" }],
        },
      ]
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, undefined, sessionMessages)
      managerUnderTest = manager
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        description: "task A",
        status: "completed",
        completedAt: new Date("2026-05-15T13:40:19.368Z"),
      })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      try {
        // when
        await notifyParentSessionForTest(manager, task)
        await waitForCoalescedFlush(manager, promptAsyncCalls)

        // then
        expect(promptAsyncCalls).toHaveLength(1)
        expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
        expect(getPendingParentWakes(manager).has("parent-1")).toBe(true)
      } finally {
        Date.now = originalDateNow
      }
    })

    test("#when parent status is idle but latest assistant turn has running tool state without finish #then background completion records a no-reply wake", async () => {
      // given
      const originalDateNow = Date.now
      Date.now = () => 1778820000000
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "idle" },
      }
      const sessionMessages: SessionMessageForTest[] = [
        {
          info: { role: "user", time: { created: 1778819814009 } },
          parts: [{ type: "text" }],
        },
        {
          info: { role: "assistant", time: { created: 1778819997535 } },
          parts: [
            { type: "tool", state: { status: "running" } },
            { type: "tool", state: { status: "pending" } },
          ],
        },
      ]
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, undefined, sessionMessages)
      managerUnderTest = manager
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        description: "task A",
        status: "completed",
        completedAt: new Date("2026-05-17T05:25:01.000Z"),
      })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      try {
        // when
        await notifyParentSessionForTest(manager, task)
        await waitForCoalescedFlush(manager, promptAsyncCalls)

        // then
        expect(promptAsyncCalls).toHaveLength(1)
        expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
        expect(getPendingParentWakes(manager).has("parent-1")).toBe(true)
      } finally {
        Date.now = originalDateNow
      }
    })

    test("#when stale tool-call history keeps blocking an all-complete wake #then the wake is admitted as noReply with reply liveness retained", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "idle" },
      }
      const sessionMessages: SessionMessageForTest[] = [
        {
          info: { role: "user", time: { created: 1778819814009 } },
          parts: [{ type: "text" }],
        },
        {
          info: { role: "assistant", finish: "tool-calls", time: { created: 1778819997535 } },
          parts: [{ type: "tool" }],
        },
      ]
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, undefined, sessionMessages)
      managerUnderTest = manager
      const queuePendingParentWake = Reflect.get(manager, "queuePendingParentWake") as (
        sessionID: string,
        notification: string,
        promptContext: Record<string, unknown>,
        shouldReply: boolean,
        delayMs?: number,
      ) => void
      queuePendingParentWake.call(
        manager,
        "parent-1",
        "<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>",
        {},
        true,
        0,
      )
      const pendingWake = getPendingParentWakes(manager).get("parent-1")
      expect(pendingWake).toBeDefined()
      if (!pendingWake) {
        throw new Error("Missing pending parent wake")
      }
      pendingWake.toolCallDeferralStartedAt = Date.now() - 60_000

      // when
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(getPendingParentWakes(manager).get("parent-1")?.shouldReply).toBe(true)
    })

    test("#when stale sdk tool-call part keeps blocking an all-complete wake #then the wake is admitted as noReply with reply liveness retained", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "idle" },
      }
      const sessionMessages: SessionMessageForTest[] = [
        {
          info: { role: "user", time: { created: 1778819814009 } },
          parts: [{ type: "text" }],
        },
        {
          info: { role: "assistant", time: { created: 1778819997535 } },
          parts: [{ type: "tool-call", state: { status: "running" } }],
        },
      ]
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, undefined, sessionMessages)
      managerUnderTest = manager
      const queuePendingParentWake = Reflect.get(manager, "queuePendingParentWake") as (
        sessionID: string,
        notification: string,
        promptContext: Record<string, unknown>,
        shouldReply: boolean,
        delayMs?: number,
      ) => void
      queuePendingParentWake.call(
        manager,
        "parent-1",
        "<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>",
        {},
        true,
        0,
      )
      const pendingWake = getPendingParentWakes(manager).get("parent-1")
      expect(pendingWake).toBeDefined()
      if (!pendingWake) {
        throw new Error("Missing pending parent wake")
      }
      pendingWake.toolCallDeferralStartedAt = Date.now() - 60_000

      // when
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(getPendingParentWakes(manager).get("parent-1")?.shouldReply).toBe(true)
    })

    test("#when stale deferral age is exceeded but latest tool turn is recent #then all-complete wake records a no-reply wake", async () => {
      // given
      const originalDateNow = Date.now
      Date.now = () => 100_000
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "idle" },
      }
      const sessionMessages: SessionMessageForTest[] = [
        {
          info: { role: "user", time: { created: 90_000 } },
          parts: [{ type: "text" }],
        },
        {
          info: { role: "assistant", finish: "tool-calls", time: { created: 99_500 } },
          parts: [{ type: "tool", state: { status: "running" } }],
        },
      ]
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, undefined, sessionMessages)
      managerUnderTest = manager
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        description: "task A",
        status: "completed",
        completedAt: new Date("2026-05-19T00:09:55.089Z"),
      })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      try {
        // when
        await notifyParentSessionForTest(manager, task)
        await waitForCoalescedFlush(manager, promptAsyncCalls)

        // then
        expect(promptAsyncCalls).toHaveLength(1)
        expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
        expect(getPendingParentWakes(manager).has("parent-1")).toBe(true)
      } finally {
        Date.now = originalDateNow
      }
    })

    test("#when all-complete notification wakes parent #then prompt stays in the same OpenCode directory instance", async () => {
      // given
      const { manager, promptAsyncCalls } = createManager(true)
      managerUnderTest = manager
      const directory = Reflect.get(manager, "directory") as string
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      // when
      await notifyParentSessionForTest(manager, task)
      await waitForCoalescedFlush(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      expect(promptAsyncCalls[0]?.query).toEqual({ directory })
    })

    test("#when busy parent later becomes idle #then completion notification wakes the parent once", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))
      await notifyParentSessionForTest(manager, task)
      expect(promptAsyncCalls).toHaveLength(0)

      // when
      sessionStatuses["parent-1"] = { type: "idle" }
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(notificationPayload).not.toContain("BACKGROUND TASK NOTIFICATION READY")
    })

    test("#when a single background task finishes during a stale busy parent status #then completion notification is retried after the parent becomes idle", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses)
      managerUnderTest = manager
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      // when
      await notifyParentSessionForTest(manager, task)
      sessionStatuses["parent-1"] = { type: "idle" }
      await waitForDeferredWake(manager, promptAsyncCalls)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      const notificationPayload = JSON.stringify(promptAsyncCalls[0]?.body.parts)
      expect(notificationPayload).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(notificationPayload).not.toContain("BACKGROUND TASK NOTIFICATION READY")
    })

    test("#when completion notification send is aborted #then parent wake is requeued for retry", async () => {
      // given
      const sessionStatuses: Record<string, { type: string }> = {
        "parent-1": { type: "busy" },
      }
      const promptError = new Error("Request aborted while waiting for input")
      promptError.name = "MessageAbortedError"
      const { manager, promptAsyncCalls } = createManager(true, sessionStatuses, async () => {
        throw promptError
      })
      managerUnderTest = manager
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      // when
      await notifyParentSessionForTest(manager, task)
      sessionStatuses["parent-1"] = { type: "idle" }
      manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
      await waitForDeferredWake(manager, promptAsyncCalls)
      await waitForRequeuedParentWake(manager, "parent-1")

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(getPendingNotifications(manager).get("parent-1")).toBeUndefined()
      const queuedNotifications = getPendingParentWakes(manager).get("parent-1")?.notifications ?? []
      expect(queuedNotifications).toHaveLength(1)
      expect(queuedNotifications[0]).toContain("ALL BACKGROUND TASKS COMPLETE")
      expect(queuedNotifications[0]).not.toContain("BACKGROUND TASK NOTIFICATION READY")
    })
  })

  describe("#given a completed task with cleanup timer scheduled", () => {
    test("#when cleanup timer fires #then task is deleted from this.tasks Map", async () => {
      // given
      const { manager } = createManager(false)
      managerUnderTest = manager
      fakeTimers = installFakeTimers()
      const task = createTask({ id: "task-a", parentSessionId: "parent-1", description: "task A", status: "completed", completedAt: new Date("2026-03-11T00:01:00.000Z") })
      getTasks(manager).set(task.id, task)
      getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

      await notifyParentSessionForTest(manager, task)
      const cleanupTimer = getRequiredTimer(manager, task.id)

      // when
      expect(fakeTimers.getDelay(cleanupTimer)).toBe(TASK_CLEANUP_DELAY_MS)
      await fakeTimers.run(cleanupTimer)

      // then
      expect(getCompletionTimers(manager).has(task.id)).toBe(false)
      expect(getTasks(manager).has(task.id)).toBe(false)
    })

    test("#when an old cleanup callback fires during a sync continuation #then the claimed task survives until the continuation releases it", async () => {
      // given
      const promptDispatches: unknown[] = []
      const deletedSessions: unknown[] = []
      let pollStarted = false
      let releasePoll: (value: string | null) => void = () => {}
      const pollPromise = new Promise<string | null>((resolve) => {
        releasePoll = resolve
      })
      const client = {
        session: {
          messages: async () => ({
            data: [{
              info: {
                id: "message-1",
                role: "assistant",
                agent: "test-agent",
                model: { providerID: "test-provider", modelID: "test-model" },
              },
            }],
          }),
          status: async () => ({ data: { "continuation-session": { type: "idle" } } }),
          prompt: async () => ({}),
          promptAsync: async (call: unknown) => {
            promptDispatches.push(call)
            return {}
          },
          abort: async () => ({}),
          delete: async (call: unknown) => {
            deletedSessions.push(call)
            return {}
          },
        },
      }
      const pluginContext: PluginInput = {
        client: client as unknown as PluginInput["client"],
        project: {} as PluginInput["project"],
        directory: tmpdir(),
        worktree: tmpdir(),
        serverUrl: new URL("http://localhost"),
        $: {} as PluginInput["$"],
        experimental_workspace: { register: () => {} },
      }
      const manager = new BackgroundManager({
        pluginContext,
        enableParentSessionNotifications: false,
      })
      managerUnderTest = manager
      fakeTimers = installFakeTimers()
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        sessionId: "continuation-session",
        status: "completed",
        completedAt: new Date("2026-03-11T00:01:00.000Z"),
      })
      getTasks(manager).set(task.id, task)
      await notifyParentSessionForTest(manager, task)
      const oldTimer = getRequiredTimer(manager, task.id)
      const oldCleanupCallback = fakeTimers.capture(oldTimer)
      const continuation = executeSyncContinuation(
        {
          task_id: task.sessionId,
          prompt: "continue task",
          description: "continue task",
          load_skills: [],
          run_in_background: false,
        },
        {
          sessionID: "parent-1",
          messageID: "message-1",
          agent: "test-agent",
          abort: new AbortController().signal,
          callID: "call-1",
          metadata: () => {},
        },
        {
          client: client as unknown as import("../../tools/delegate-task/types").OpencodeClient,
          directory: pluginContext.directory,
          manager,
          syncPollTimeoutMs: 1_000,
        },
        { sessionID: "parent-1", messageID: "message-2" },
        {
          pollSyncSession: async () => {
            pollStarted = true
            return pollPromise
          },
          fetchSyncResult: async () => ({ ok: true as const, textContent: "continued" }),
        },
      )

      for (let attempts = 0; attempts < 10 && !pollStarted; attempts += 1) {
        await flushMicrotasks()
      }
      expect(pollStarted).toBe(true)

      // when
      await oldCleanupCallback()

      // then
      expect(deletedSessions).toHaveLength(0)
      expect(manager.getTask(task.id)).toBe(task)
      expect(promptDispatches).toHaveLength(1)

      releasePoll(null)
      await continuation
      const replacementTimer = getRequiredTimer(manager, task.id)
      expect(replacementTimer).not.toBe(oldTimer)
      await oldCleanupCallback()
      expect(deletedSessions).toHaveLength(0)
      expect(getCompletionTimers(manager).get(task.id)).toBe(replacementTimer)
      await fakeTimers.run(replacementTimer)
      expect(deletedSessions).toHaveLength(1)
    })

    test("#when a sync continuation claim has a foreign parent or duplicate owner #then cleanup ownership is unchanged", async () => {
      // given
      const { manager } = createManager(false)
      managerUnderTest = manager
      fakeTimers = installFakeTimers()
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        sessionId: "continuation-session",
        status: "completed",
      })
      getTasks(manager).set(task.id, task)
      await notifyParentSessionForTest(manager, task)
      const originalTimer = getRequiredTimer(manager, task.id)

      // when
      expect(() => manager.claimSyncContinuation(task.sessionId!, "foreign-parent")).toThrow()
      const releaseClaim = manager.claimSyncContinuation(task.sessionId!, task.parentSessionId)
      expect(() => manager.claimSyncContinuation(task.sessionId!, task.parentSessionId)).toThrow()
      const resumeAttempt = manager.resume({
        sessionId: task.sessionId!,
        prompt: "resume task",
        parentSessionId: task.parentSessionId,
        parentMessageId: task.parentMessageId,
      })
      const resumeError = await resumeAttempt.then(
        () => undefined,
        (error: unknown) => error,
      )

      // then
      expect(resumeError).toBeInstanceOf(Error)
      expect(getCompletionTimers(manager).has(task.id)).toBe(false)
      releaseClaim?.()
      const replacementTimer = getRequiredTimer(manager, task.id)
      expect(replacementTimer).not.toBe(originalTimer)
      releaseClaim?.()
      expect(getCompletionTimers(manager).get(task.id)).toBe(replacementTimer)
    })

    test("#when sync continuation prompt dispatch fails #then the manager claim is released", async () => {
      // given
      const promptError = new Error("prompt failed")
      const { manager } = createManager(false, undefined, async () => {
        throw promptError
      })
      managerUnderTest = manager
      const client = Reflect.get(manager, "client")
      const task = createTask({
        id: "task-a",
        parentSessionId: "parent-1",
        sessionId: "continuation-session",
        status: "completed",
      })
      getTasks(manager).set(task.id, task)
      await notifyParentSessionForTest(manager, task)

      // when
      const result = await executeSyncContinuation(
        {
          task_id: task.sessionId,
          prompt: "continue task",
          description: "continue task",
          load_skills: [],
          run_in_background: false,
        },
        {
          sessionID: task.parentSessionId,
          messageID: "message-1",
          agent: "test-agent",
          abort: new AbortController().signal,
          callID: "call-1",
          metadata: () => {},
        },
        {
          client: client as unknown as import("../../tools/delegate-task/types").OpencodeClient,
          directory: Reflect.get(manager, "directory") as string,
          manager,
        },
        { sessionID: task.parentSessionId, messageID: "message-2" },
      )

      // then
      expect(result).toContain("Failed to send continuation prompt")
      const releaseClaim = manager.claimSyncContinuation(task.sessionId!, task.parentSessionId)
      expect(releaseClaim).toBeDefined()
      releaseClaim?.()
    })
  })
})

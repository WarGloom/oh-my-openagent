/// <reference types="bun-types" />

import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { releaseAllPromptAsyncReservationsForTesting, releasePromptAsyncReservation } from "../../hooks/shared/prompt-async-gate"

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

type PendingParentWakeForTest = {
  notifications: string[]
  shouldReply: boolean
  queuedAt?: number
  noReplyAdmittedAt?: number
}

let managerUnderTest: BackgroundManager | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
  managerUnderTest = undefined
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
    startedAt: overrides.startedAt ?? new Date("2026-05-20T14:19:10.000Z"),
    ...rest,
    id,
    parentSessionId: parentSessionID,
  }
}

type SessionStatusProvider = Record<string, { type: string }> | (() => Record<string, { type: string }>)

function createManager(sessionStatuses: SessionStatusProvider): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" })
  Object.assign(client.session, {
    messages: async () => [],
    status: async () => ({ data: typeof sessionStatuses === "function" ? sessionStatuses() : sessionStatuses }),
    prompt: async () => ({}),
    promptAsync: async (call: PromptAsyncCall) => {
      promptAsyncCalls.push(call)
      return {}
    },
    abort: async () => ({}),
  })
    },
    abort: async () => ({}),
  })
  const ctx: PluginInput = {
    client,
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  const manager = new BackgroundManager({
    pluginContext: ctx,
    config: undefined,
    enableParentSessionNotifications: true,
  })

  return { manager, promptAsyncCalls }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

function getPendingParentWakes(manager: BackgroundManager): Map<string, PendingParentWakeForTest> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakes: () => Map<string, PendingParentWakeForTest>
  }
  return parentWakeNotifier.getPendingParentWakes()
}

async function notifyParentSessionForTest(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (task: BackgroundTask) => Promise<void>
  return notifyParentSession.call(manager, task)
}

async function flushPendingParentWakeForTest(manager: BackgroundManager, sessionID: string): Promise<void> {
  const flushPendingParentWake = Reflect.get(manager, "flushPendingParentWake") as (sessionID: string) => Promise<void>
  return flushPendingParentWake.call(manager, sessionID)
}

describe("BackgroundManager parent wake active turn events", () => {
  test("#when background task completes during active parent turn #then parent wake stays queued without prompt injection", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "busy" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(0)
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(true)
  })

  test("#when duplicate background completions overlap an active parent turn #then one coalesced wake stays queued", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "busy" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    const taskA = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    const taskB = createTask({
      id: "task-b",
      parentSessionId: "parent-1",
      description: "task B",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:15.625Z"),
    })
    getTasks(manager).set(taskA.id, taskA)
    getTasks(manager).set(taskB.id, taskB)
    getPendingByParent(manager).set(taskA.parentSessionId, new Set([taskA.id, taskB.id]))

    // when
    await notifyParentSessionForTest(manager, taskA)
    await notifyParentSessionForTest(manager, taskB)
    await Promise.all([
      flushPendingParentWakeForTest(manager, "parent-1"),
      flushPendingParentWakeForTest(manager, "parent-1"),
    ])

    // then
    expect(promptAsyncCalls).toHaveLength(0)
    const pendingWake = getPendingParentWakes(manager).get("parent-1")
    expect(pendingWake).toBeDefined()
    expect(JSON.stringify(pendingWake?.notifications)).toContain("ALL BACKGROUND TASKS COMPLETE")
  })

  test("#when background task fails during active parent turn #then parent wake stays queued without prompt injection", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "busy" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "error",
      error: "UnknownError: UnknownError",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(0)
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(true)
  })

  test("#when failed all-complete wake sees active parent before an idle gate check #then it dispatches like other completion summaries", async () => {
    // given
    const statusSequence: Array<Record<string, { type: string }>> = [
      { "parent-1": { type: "busy" } },
      { "parent-1": { type: "idle" } },
    ]
    const { manager, promptAsyncCalls } = createManager(() => statusSequence.shift() ?? { "parent-1": { type: "idle" } })
    managerUnderTest = manager
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "error",
      error: "UnknownError: UnknownError",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
    expect(JSON.stringify(promptAsyncCalls[0]?.body.parts)).toContain("ALL BACKGROUND TASKS FINISHED - 1 FAILED")
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(false)
  })

  test("#when fallback retry starts during active parent turn #then parent prompt is not injected", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "busy" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    const queuePendingParentWake = Reflect.get(manager, "queuePendingParentWake") as (
      sessionID: string,
      notification: string,
      promptContext: Record<string, unknown>,
      shouldReply: boolean,
      delayMs?: number,
    ) => void

    // when
    queuePendingParentWake.call(
      manager,
      "parent-1",
       `<system-reminder>
[BACKGROUND TASK RETRYING]
**ID:** \`bg-retry\`
**Retry attempt:** 2
</system-reminder>`,
      { agent: "atlas" },
      false,
      0,
    )
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(0)
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(false)
  })

  test("#when parent reasoning delta is newer than stale idle state #then background completion does not fork a reply", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "parent-1",
        field: "reasoning",
        delta: "still thinking",
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
    expect(getPendingParentWakes(manager).get("parent-1")?.shouldReply).toBe(true)
  })

  test("#when parent idle event follows fresh reasoning delta #then background completion still records an admit-only wake", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "parent-1",
        field: "reasoning",
        delta: "still thinking",
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
    expect(getPendingParentWakes(manager).get("parent-1")?.shouldReply).toBe(true)
  })

  test("#when completed parent assistant update precedes all-complete wake #then completion starts a reply", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
          finish: "stop",
        },
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
    expect(JSON.stringify(promptAsyncCalls[0]?.body.parts)).toContain("ALL BACKGROUND TASKS COMPLETE")
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(false)
  })


  test("#when completed end_turn parent assistant update precedes all-complete wake #then completion starts a reply", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
        },
      },
    })
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
          finish: "end_turn",
        },
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
    expect(JSON.stringify(promptAsyncCalls[0]?.body.parts)).toContain("ALL BACKGROUND TASKS COMPLETE")
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(false)
  })

  test("#when all-complete wake is admitted noReply during active parent turn #then terminal parent output requeues a reply wake", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
        },
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)

    // when
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
          finish: "stop",
        },
      },
    })
    const released = releasePromptAsyncReservation("parent-1", "test:simulate-expired-parent-wake-hold", {
      reservedBy: "background-agent-parent-wake",
    })
    expect(released).toBe(true)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(2)
    expect(promptAsyncCalls[1]?.body.noReply).toBe(false)
    expect(JSON.stringify(promptAsyncCalls[1]?.body.parts)).toContain("ALL BACKGROUND TASKS COMPLETE")
    expect(getPendingParentWakes(manager).has("parent-1")).toBe(false)
  })

  test("#when active parent assistant update precedes completion #then reply-required wake stays retained after admit-only dispatch", async () => {
    // given
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager
    manager.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "parent-1",
          role: "assistant",
        },
      },
    })
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when
    await notifyParentSessionForTest(manager, task)
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
    const retainedWake = getPendingParentWakes(manager).get("parent-1")
    expect(retainedWake?.shouldReply).toBe(true)
    expect(retainedWake?.noReplyAdmittedAt).toBeDefined()
  })
})

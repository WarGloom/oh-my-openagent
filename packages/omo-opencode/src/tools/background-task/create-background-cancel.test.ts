/// <reference types="bun-types" />

// Audit snapshot: internal non-test skipNotification:true callers still exist in:
// - src/features/team-mode/team-runtime/cleanup-team-run-resources.ts
// - src/hooks/stop-continuation-guard/hook.ts
// - src/tools/delegate-task/cancel-unstable-agent-task.ts

import { describe, test, expect } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { BackgroundManager, BackgroundTask } from "../../features/background-agent"
import type { BackgroundCancelClient } from "./tools"
import { createBackgroundCancel } from "./create-background-cancel"
import { unsafeTestValue } from "../../../test-support/unsafe-test-value"

const projectDir = "/Users/yeongyu/local-workspaces/oh-my-opencode"

const mockContext = unsafeTestValue<ToolContext>({
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  directory: projectDir,
  worktree: projectDir,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
})

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionId: "ses-1",
    parentSessionId: "main-1",
    parentMessageId: "msg-1",
    description: "background task",
    prompt: "do work",
    agent: "test-agent",
    status: "running",
    ...overrides,
  }
}

function createClient(): BackgroundCancelClient {
  return unsafeTestValue<BackgroundCancelClient>({})
}

function hasSkipNotification(options: unknown): boolean {
  return typeof options === "object" && options !== null && Object.prototype.hasOwnProperty.call(options, "skipNotification")
}

describe("background_cancel regression", () => {
  test("cancels a running task without forcing skipNotification", async () => {
    // #given
    const task = createTask({ id: "task-running", status: "running", sessionId: "ses-running" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: (id: string) => (id === task.id ? task : undefined),
      getAllDescendantTasks: () => [task],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        task.status = "cancelled"
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ taskId: task.id }, mockContext)

    // #then
    expect(cancelOptions).toHaveLength(1)
    expect(cancelOptions[0]?.taskId).toBe(task.id)
    expect(cancelOptions[0]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: true }))
    expect(hasSkipNotification(cancelOptions[0]?.options)).toBe(false)
    expect(output).toContain("Task cancelled successfully")
    expect(output).toContain("Session ID: ses-running")
  })

  test("cancels a pending task without forcing skipNotification", async () => {
    // #given
    const task = createTask({ id: "task-pending", status: "pending", sessionId: undefined, description: "pending task" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: (id: string) => (id === task.id ? task : undefined),
      getAllDescendantTasks: () => [task],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        task.status = "cancelled"
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ taskId: task.id }, mockContext)

    // #then
    expect(cancelOptions).toHaveLength(1)
    expect(cancelOptions[0]?.taskId).toBe(task.id)
    expect(cancelOptions[0]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: false }))
    expect(hasSkipNotification(cancelOptions[0]?.options)).toBe(false)
    expect(output).toContain("Task cancelled successfully")
    expect(output).toContain("Description: pending task")
    expect(output).toContain("Status: cancelled")
  })

  test("returns an error when the task is not found", async () => {
    // #given
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: () => undefined,
      getAllDescendantTasks: () => [],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ taskId: "missing-task" }, mockContext)

    // #then
    expect(output).toContain("Task not found: missing-task")
    expect(cancelOptions).toHaveLength(0)
  })

  test("returns an error for a non-cancellable task status", async () => {
    // #given
    const task = createTask({ id: "task-completed", status: "completed" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: (id: string) => (id === task.id ? task : undefined),
      getAllDescendantTasks: () => [task],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ taskId: task.id }, mockContext)

    // #then
    expect(output).toContain('current status is "completed"')
    expect(output).toContain("Only running or pending tasks can be cancelled.")
    expect(cancelOptions).toHaveLength(0)
  })

  test("returns an error for invalid arguments", async () => {
    // #given
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: () => undefined,
      getAllDescendantTasks: () => [],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({}, mockContext)

    // #then
    expect(output).toContain("Either provide a taskId or set all=true")
    expect(cancelOptions).toHaveLength(0)
  })

  test("cancels two running-or-pending tasks without forcing skipNotification", async () => {
    // #given
    const taskA = createTask({ id: "task-a", status: "running", sessionId: "ses-a", description: "running task" })
    const taskB = createTask({ id: "task-b", status: "pending", sessionId: undefined, description: "pending task" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: () => undefined,
      getAllDescendantTasks: () => [taskA, taskB],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        const task = taskId === taskA.id ? taskA : taskB
        task.status = "cancelled"
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ all: true }, mockContext)

    // #then
    expect(cancelOptions).toHaveLength(2)
    expect(cancelOptions[0]?.taskId).toBe(taskA.id)
    expect(cancelOptions[0]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: true }))
    expect(hasSkipNotification(cancelOptions[0]?.options)).toBe(false)
    expect(cancelOptions[1]?.taskId).toBe(taskB.id)
    expect(cancelOptions[1]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: false }))
    expect(hasSkipNotification(cancelOptions[1]?.options)).toBe(false)
    expect(output).toContain("Cancelled 2 background task(s)")
    expect(output).toContain("| `task-a` | running task | running | `ses-a` |")
    expect(output).toContain("| `task-b` | pending task | pending | (not started) |")
  })

  test("returns an empty-list message when cancelAll has no running or pending tasks", async () => {
    // #given
    const task = createTask({ id: "task-finished", status: "completed" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: () => undefined,
      getAllDescendantTasks: () => [task],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ all: true }, mockContext)

    // #then
    expect(output).toBe("No running or pending background tasks to cancel.")
    expect(cancelOptions).toHaveLength(0)
  })

  test("skips non-cancellable tasks while cancelAll still targets running and pending descendants", async () => {
    // #given
    const runningTask = createTask({ id: "task-running", status: "running", sessionId: "ses-running", description: "running task" })
    const pendingTask = createTask({ id: "task-pending", status: "pending", sessionId: "ses-pending", description: "pending task" })
    const completedTask = createTask({ id: "task-completed", status: "completed", sessionId: "ses-completed", description: "completed task" })
    const cancelOptions: Array<{ taskId: string; options: unknown }> = []
    const manager = unsafeTestValue<BackgroundManager>({
      getTask: () => undefined,
      getAllDescendantTasks: () => [runningTask, completedTask, pendingTask],
      cancelTask: async (taskId: string, options?: unknown) => {
        cancelOptions.push({ taskId, options })
        const task = taskId === runningTask.id ? runningTask : pendingTask
        task.status = "cancelled"
        return true
      },
    })
    const tool = createBackgroundCancel(manager, createClient())

    // #when
    const output = await tool.execute({ all: true }, mockContext)

    // #then
    expect(cancelOptions).toHaveLength(2)
    expect(cancelOptions[0]?.taskId).toBe(runningTask.id)
    expect(cancelOptions[0]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: true }))
    expect(hasSkipNotification(cancelOptions[0]?.options)).toBe(false)
    expect(cancelOptions[1]?.taskId).toBe(pendingTask.id)
    expect(cancelOptions[1]?.options).toEqual(expect.objectContaining({ source: "background_cancel", abortSession: false }))
    expect(hasSkipNotification(cancelOptions[1]?.options)).toBe(false)
    expect(output).toContain("Cancelled 2 background task(s)")
    expect(output).toContain("| `task-running` | running task | running | `ses-running` |")
    expect(output).toContain("| `task-pending` | pending task | pending | `ses-pending` |")
    expect(output).not.toContain("completed task")
  })
})

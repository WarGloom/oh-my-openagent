/// <reference types="bun-types" />

import { describe, test, expect, mock } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import { getProviderAutoRetryDeferral } from "./provider-auto-retry-deferral"
import { MIN_SESSION_GONE_POLLS } from "./session-existence"
import type { BackgroundTask } from "./types"

function createPluginContext(client: object): PluginInput {
  const directory = tmpdir()
  return {
    project: {
      id: "test-project",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    experimental_workspace: { register: () => {} },
    $: {} as PluginInput["$"],
    client: client as PluginInput["client"],
  }
}

function createManagerWithStatus(statusImpl: () => Promise<{ data: Record<string, { type: string }> }>): BackgroundManager {
  const client = {
    session: {
      status: statusImpl,
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  }

  return new BackgroundManager({ pluginContext: createPluginContext(client) })
}

describe("BackgroundManager polling overlap", () => {
  test("skips overlapping pollRunningTasks executions", async () => {
    //#given
    let activeCalls = 0
    let maxActiveCalls = 0
    let statusCallCount = 0
    let releaseStatus: (() => void) | undefined
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })

    const manager = createManagerWithStatus(async () => {
      statusCallCount += 1
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await statusGate
      activeCalls -= 1
      return { data: {} }
    })

    //#when
    const firstPoll = manager["pollRunningTasks"]()
    await Promise.resolve()
    const secondPoll = manager["pollRunningTasks"]()
    releaseStatus?.()
    await Promise.all([firstPoll, secondPoll])
    manager.shutdown()

    //#then
    expect(maxActiveCalls).toBe(1)
    expect(statusCallCount).toBe(1)
  })
})


function createRunningTask(sessionId: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: `bg_test_${sessionId}`,
    sessionId,
    parentSessionId: "parent-session",
    parentMessageId: "parent-msg",
    description: "test task",
    prompt: "test",
    agent: "explore",
    status: "running",
    startedAt: new Date(),
    progress: { toolCalls: 0, lastUpdate: new Date() },
    ...overrides,
  }
}

function injectTask(manager: BackgroundManager, task: BackgroundTask): void {
  manager["tasks"].set(task.id, task)
}

function createManagerWithClient(clientOverrides: Record<string, unknown> = {}): BackgroundManager {
  const client = {
    session: {
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: "ses-default" } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({
        data: [{
          info: { role: "assistant", finish: "end_turn", id: "msg-2" },
          parts: [{ type: "text", text: "done" }],
        }, {
          info: { role: "user", id: "msg-1" },
          parts: [{ type: "text", text: "go" }],
        }],
      }),
      ...clientOverrides,
    },
  }
  return new BackgroundManager(
    { pluginContext: createPluginContext(client), config: undefined, enableParentSessionNotifications: false },
  )
}

describe("BackgroundManager verifySessionExists", () => {
  describe("#given session.get reports a not-found response", () => {
    test("#when verifySessionExists runs #then it returns false", async () => {
      //#given
      const manager = createManagerWithClient({
        get: async () => ({
          error: { message: "Session not found", status: 404 },
          data: undefined,
        }),
      })

      //#when
      const result = await manager["verifySessionExists"]("ses-missing")
      await manager.shutdown()

      //#then
      expect(result).toBe(false)
    })
  })

  describe("#given session.get reports a transient transport error", () => {
    test("#when verifySessionExists runs #then it returns true", async () => {
      //#given
      const manager = createManagerWithClient({
        get: async () => ({
          error: { message: "Network timeout", status: 500 },
          data: undefined,
        }),
      })

      //#when
      const result = await manager["verifySessionExists"]("ses-transient")
      await manager.shutdown()

      //#then
      expect(result).toBe(true)
    })
  })
})

describe("BackgroundManager pollRunningTasks", () => {
  describe("#given a running task whose session is no longer in status response", () => {
    test("#when pollRunningTasks runs #then completes the task instead of leaving it running", async () => {
      //#given
      const manager = createManagerWithClient()
      const task = createRunningTask("ses-gone")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test("#when the first missing-status poll has no output #then it does not fail the task yet", async () => {
      //#given
      const getSession = mock(async () => ({
        error: { message: "Session not found", status: 404 },
        data: undefined,
      }))
      const manager = createManagerWithClient({
        get: getSession,
        messages: async () => ({ data: [] }),
      })
      const task = createRunningTask("ses-first-miss")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
      expect(task.consecutiveMissedPolls).toBe(1)
      expect(getSession).not.toHaveBeenCalled()
    })

    test("#when status polling is unavailable #then it does not complete or increment missed polls", async () => {
      const cases: Array<{ name: string; status?: (() => Promise<{ data: Record<string, { type: string }> }>) | undefined }> = [
        { name: "missing status method", status: undefined },
        { name: "throwing status method", status: async () => { throw new Error("status unavailable") } },
      ]

      for (const testCase of cases) {
        //#given
        let abortCallCount = 0
        const manager = createManagerWithClient({
          status: testCase.status,
          abort: async () => {
            abortCallCount += 1
            return {}
          },
        })
        const task = createRunningTask(`ses-${testCase.name.replace(/ /g, "-")}`, {
          fallbackChain: [
            { model: "gpt-5.6", providers: ["openai"] },
            { model: "claude-sonnet-4-6", providers: ["anthropic"] },
          ],
          attemptCount: 0,
        })
        injectTask(manager, task)
        const retryStatus = {
          attempt: 1,
          message: "Our servers are currently overloaded. Please try again later.",
        }
        const observationStart = 1_800_000_000_000
        expect(getProviderAutoRetryDeferral(task, retryStatus, observationStart)).toBeDefined()

        //#when
        const poll = manager["pollRunningTasks"]
        for (let count = 0; count < MIN_SESSION_GONE_POLLS + 1; count += 1) {
          await poll.call(manager)
        }

        //#then
        expect(task.status).toBe("running")
        expect(task.completedAt).toBeUndefined()
        expect(task.error).toBeUndefined()
        expect(task.consecutiveMissedPolls ?? 0).toBe(0)
        expect(abortCallCount).toBe(0)
        expect(
          getProviderAutoRetryDeferral(task, retryStatus, observationStart + 30_000),
        ).toBeUndefined()

        await manager.shutdown()
      }
    })

    test("#when reliable status polling omits the session #then it completes through the session-gone path", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: {} }),
      })
      const task = createRunningTask("ses-reliably-gone")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      for (let count = 0; count < MIN_SESSION_GONE_POLLS; count += 1) {
        await poll.call(manager)
      }
      await manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })
  })

  describe("#given a running task whose session status is idle", () => {
    test("#when pollRunningTasks runs #then completes the task", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle": { type: "idle" } } }),
      })
      const task = createRunningTask("ses-idle")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
    })

    test("#when output was already observed from events #then it still checks latest assistant finish before completion", async () => {
      //#given
      let messagesCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-cached": { type: "idle" } } }),
        messages: async () => {
          messagesCallCount += 1
          return {
            data: [{
              info: { role: "assistant", finish: "end_turn", id: "msg-2" },
              parts: [{ type: "text", text: "done" }],
            }],
          }
        },
      })
      const task = createRunningTask("ses-idle-cached")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-cached", type: "text" },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(messagesCallCount).toBe(1)
    })

    test("#when todo state was already observed from events #then it completes without fetching todos", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-todo-cached": { type: "idle" } } }),
        todo: async () => {
          todoCallCount += 1
          return { data: [] }
        },
      })
      const task = createRunningTask("ses-idle-todo-cached")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-todo-cached", type: "text" },
      })
      manager.handleEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses-idle-todo-cached",
          todos: [
            { id: "todo-1", content: "done", status: "completed", priority: "high" },
          ],
        },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(todoCallCount).toBe(0)
    })

    test("#when cached completed todos are invalidated before idle polling #then it refreshes and waits on fresh incomplete todos", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-invalidated-todos": { type: "idle" } } }),
        todo: async () => {
          todoCallCount += 1
          return {
            data: [
              { content: "continue result", status: "in_progress", priority: "high" },
            ],
          }
        },
      })
      const task = createRunningTask("ses-idle-invalidated-todos")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-invalidated-todos", type: "text" },
      })
      manager.handleEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses-idle-invalidated-todos",
          todos: [
            { content: "continue result", status: "completed", priority: "high" },
          ],
        },
      })

      manager.invalidateSessionTodoObservation("ses-idle-invalidated-todos")

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)

      //#then
      expect(task.status).toBe("running")
      expect(task.completedAt).toBeUndefined()
      expect(todoCallCount).toBe(1)

      await manager.shutdown()
    })

    test("#when cached incomplete todos become complete before idle polling #then refreshes todos and completes", async () => {
      //#given
      let todoCallCount = 0
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-stale-todos": { type: "idle" } } }),
        todo: async () => {
          todoCallCount += 1
          return {
            data: [
              { content: "compile result", status: "completed", priority: "high" },
            ],
          }
        },
      })
      const task = createRunningTask("ses-idle-stale-todos")
      injectTask(manager, task)

      manager.handleEvent({
        type: "message.part.updated",
        properties: { sessionID: "ses-idle-stale-todos", type: "text" },
      })
      manager.handleEvent({
        type: "todo.updated",
        properties: {
          sessionID: "ses-idle-stale-todos",
          todos: [
            { content: "compile result", status: "in_progress", priority: "high" },
          ],
        },
      })

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(todoCallCount).toBe(1)
    })

    test("#when idle task has no valid output and fallback is available #then retries through fallback instead of staying stuck", async () => {
      //#given
      const promptAsync = mock(async () => ({}))
      const onSessionCreated = mock(async () => {})
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-no-output": { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        promptAsync,
      })
      const task = createRunningTask("ses-idle-no-output", {
        model: { providerID: "provider-a", modelID: "original-model" },
        concurrencyKey: "provider-a/original-model",
        concurrencyGroup: "provider-a/original-model",
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
        teamRunId: "team-run-1",
        attemptCount: 0,
        onSessionCreated,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)

      //#then
      expect(promptAsync).toHaveBeenCalled()
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe("ses-idle-no-output")
      expect(task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(task.attemptCount).toBe(1)
      expect(onSessionCreated).toHaveBeenCalledWith("ses-idle-no-output", {
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })

      await manager.shutdown()
    })

    test("#when polling sees no output immediately after same-session fallback dispatch #then waits instead of consuming the next fallback", async () => {
      //#given
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-repeat-after-fallback": { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        promptAsync,
      })
      const task = createRunningTask("ses-idle-repeat-after-fallback", {
        model: { providerID: "provider-a", modelID: "original-model" },
        concurrencyKey: "provider-a/original-model",
        concurrencyGroup: "provider-a/original-model",
        fallbackChain: [
          { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
          { model: "fallback-model-2", providers: ["provider-a"], variant: undefined },
        ],
        teamRunId: "team-run-1",
        attemptCount: 0,
        onSessionCreated: mock(async () => {}),
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await poll.call(manager)

      //#then
      expect(promptAsync).toHaveBeenCalledTimes(1)
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe("ses-idle-repeat-after-fallback")
      expect(task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(task.attemptCount).toBe(1)

      await manager.shutdown()
    })

    test("#when idle task has prior tool output but latest assistant turn is empty and incomplete #then retries through fallback", async () => {
      for (const latestFinish of ["unknown", "tool-calls"] as const) {
        //#given
        const sessionID = `ses-idle-incomplete-latest-${latestFinish}`
        const promptAsync = mock(async () => ({}))
        const onSessionCreated = mock(async () => {})
        const manager = createManagerWithClient({
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
          messages: async () => ({
            data: [{
              info: { role: "user", id: "msg-1" },
              parts: [{ type: "text", text: "go" }],
            }, {
              info: { role: "assistant", finish: "end_turn", id: "msg-2" },
              parts: [{ type: "tool" }],
            }, {
              info: { role: "tool", id: "msg-3" },
              parts: [{ type: "tool_result", content: "command output" }],
            }, {
              info: { role: "assistant", finish: latestFinish, id: "msg-4" },
              parts: [],
            }],
          }),
          promptAsync,
        })
        const task = createRunningTask(sessionID, {
          model: { providerID: "provider-a", modelID: "original-model" },
          concurrencyKey: "provider-a/original-model",
          concurrencyGroup: "provider-a/original-model",
          fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
          teamRunId: "team-run-1",
          attemptCount: 0,
          onSessionCreated,
        })
        injectTask(manager, task)

        //#when
        const poll = manager["pollRunningTasks"]
        await poll.call(manager)

        //#then
        expect(promptAsync).toHaveBeenCalled()
        expect(task.status).toBe("running")
        expect(task.sessionId).toBe(sessionID)
        expect(task.model).toEqual({
          providerID: "provider-a",
          modelID: "fallback-model-1",
          variant: undefined,
        })
        expect(task.attemptCount).toBe(1)
        expect(onSessionCreated).toHaveBeenCalledWith(sessionID, {
          providerID: "provider-a",
          modelID: "fallback-model-1",
          variant: undefined,
        })

        await manager.shutdown()
      }
    })

    test("#when idle task has partial text in latest incomplete assistant turn #then retries through fallback", async () => {
      //#given
      const sessionID = "ses-idle-incomplete-latest-text"
      const promptAsync = mock(async () => ({}))
      const onSessionCreated = mock(async () => {})
      const manager = createManagerWithClient({
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        messages: async () => ({
          data: [{
            info: { role: "user", id: "msg-1" },
            parts: [{ type: "text", text: "go" }],
          }, {
            info: { role: "assistant", finish: "unknown", id: "msg-2" },
            parts: [{ type: "text", text: "Thought: checking workspace" }],
          }],
        }),
        promptAsync,
      })
      const task = createRunningTask(sessionID, {
        model: { providerID: "provider-a", modelID: "original-model" },
        concurrencyKey: "provider-a/original-model",
        concurrencyGroup: "provider-a/original-model",
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
        teamRunId: "team-run-1",
        attemptCount: 0,
        onSessionCreated,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)

      //#then
      expect(promptAsync).toHaveBeenCalled()
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe(sessionID)
      expect(task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(task.attemptCount).toBe(1)
      expect(onSessionCreated).toHaveBeenCalledWith(sessionID, {
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })

      await manager.shutdown()
    })

    test("#when idle task has latest incomplete assistant turn with tool evidence #then retries through fallback", async () => {
      for (const latestFinish of ["unknown", "tool-calls"] as const) {
        //#given
        const sessionID = `ses-idle-incomplete-latest-tool-${latestFinish}`
        const promptAsync = mock(async () => ({}))
        const onSessionCreated = mock(async () => {})
        const manager = createManagerWithClient({
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
          messages: async () => ({
            data: [{
              info: { role: "user", id: "msg-1" },
              parts: [{ type: "text", text: "go" }],
            }, {
              info: { role: "assistant", finish: latestFinish, id: "msg-2" },
              parts: [{ type: "tool" }],
            }],
          }),
          promptAsync,
        })
        const task = createRunningTask(sessionID, {
          model: { providerID: "provider-a", modelID: "original-model" },
          concurrencyKey: "provider-a/original-model",
          concurrencyGroup: "provider-a/original-model",
          fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
          teamRunId: "team-run-1",
          attemptCount: 0,
          onSessionCreated,
        })
        injectTask(manager, task)

        //#when
        const poll = manager["pollRunningTasks"]
        await poll.call(manager)

        //#then
        expect(promptAsync).toHaveBeenCalled()
        expect(task.status).toBe("running")
        expect(task.sessionId).toBe(sessionID)
        expect(task.model).toEqual({
          providerID: "provider-a",
          modelID: "fallback-model-1",
          variant: undefined,
        })
        expect(task.attemptCount).toBe(1)
        expect(onSessionCreated).toHaveBeenCalledWith(sessionID, {
          providerID: "provider-a",
          modelID: "fallback-model-1",
          variant: undefined,
        })

        await manager.shutdown()
      }
    })

    test("#when idle task has incomplete latest assistant turn with tool evidence but no fallback is available #then waits without failing the task", async () => {
      //#given
      const sessionID = "ses-idle-incomplete-latest-tool-no-fallback"
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        messages: async () => ({
          data: [{
            info: { role: "user", id: "msg-1" },
            parts: [{ type: "text", text: "go" }],
          }, {
            info: { role: "assistant", finish: "tool-calls", id: "msg-2" },
            parts: [{ type: "tool" }],
          }],
        }),
        promptAsync,
      })
      const task = createRunningTask(sessionID)
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
      expect(promptAsync).not.toHaveBeenCalled()
    })

    test("#when session is busy with an incomplete tool-calls turn #then never classifies output or triggers fallback", async () => {
      //#given a long-running tool keeps the session busy (isActiveSessionStatus short-circuits before classification)
      const sessionID = "ses-busy-incomplete-long-running-tool"
      const promptAsync = mock(async () => ({}))
      const messages = mock(async () => ({
        data: [{
          info: { role: "user", id: "msg-1" },
          parts: [{ type: "text", text: "go" }],
        }, {
          info: { role: "assistant", finish: "tool-calls", id: "msg-2" },
          parts: [{ type: "tool" }],
        }],
      }))
      const manager = createManagerWithClient({
        status: async () => ({ data: { [sessionID]: { type: "busy" } } }),
        messages,
        promptAsync,
      })
      const task = createRunningTask(sessionID, {
        model: { providerID: "provider-a", modelID: "original-model" },
        concurrencyKey: "provider-a/original-model",
        concurrencyGroup: "provider-a/original-model",
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
        teamRunId: "team-run-1",
        attemptCount: 0,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(messages).not.toHaveBeenCalled()
      expect(promptAsync).not.toHaveBeenCalled()
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
      expect(task.model).toEqual({ providerID: "provider-a", modelID: "original-model" })
      expect(task.attemptCount).toBe(0)
    })

    test("#when idle task has no valid output and no fallback is available #then fails the task", async () => {
      //#given
      const sessionID = "ses-idle-no-output-polling-no-fallback"
      const abort = mock(async () => ({}))
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        abort,
        promptAsync,
      })
      const task = createRunningTask(sessionID)
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toBe("Subagent session became idle without assistant/tool output and no fallback retry was available.")
      expect(abort).toHaveBeenCalledWith({ path: { id: sessionID } })
      expect(promptAsync).not.toHaveBeenCalled()
    })
  })

  describe("#given a running task whose session status is busy", () => {
    test("#when pollRunningTasks runs #then keeps the task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-busy": { type: "busy" } } }),
      })
      const task = createRunningTask("ses-busy")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("running")
    })

    test("#when progress is older than prune TTL #then active status still keeps the task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-busy-stale": { type: "busy" } } }),
      })
      const task = createRunningTask("ses-busy-stale")
      task.startedAt = new Date(Date.now() - 60 * 60 * 1000)
      task.progress = {
        toolCalls: 4,
        lastUpdate: new Date(Date.now() - 35 * 60 * 1000),
      }
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.error).toBeUndefined()
    })
  })

  describe("#given a running task whose session status is retry", () => {
    test("#when first provider retry has fallback available #then waits on same session without consuming fallback", async () => {
      //#given
      const sessionID = "ses-retry-provider-autoretry"
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({
          data: {
            [sessionID]: {
              type: "retry",
              message: "Our servers are currently overloaded. Please try again later.",
              attempt: 1,
            },
          },
        }),
        promptAsync,
      })
      const task = createRunningTask(sessionID, {
        model: { providerID: "openai", modelID: "gpt-5.4-mini" },
        concurrencyKey: "openai/gpt-5.4-mini",
        concurrencyGroup: "openai/gpt-5.4-mini",
        fallbackChain: [
          { model: "gpt-5.4-mini", providers: ["openai"] },
          { model: "claude-sonnet-4-5", providers: ["anthropic"], variant: "max" },
        ],
        attemptCount: 0,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe(sessionID)
      expect(task.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5.4-mini",
      })
      expect(task.attemptCount).toBe(0)
      expect(promptAsync).not.toHaveBeenCalled()
    })

    test("#when provider reports a hard session limit on attempt one #then immediately uses the fallback", async () => {
      //#given
      const sessionID = "ses-retry-hard-session-limit"
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({
          data: {
            [sessionID]: {
              type: "retry",
              message: "Too Many Requests: {\"error\":{\"message\":\"Sorry, you've exceeded your 5 hour session limits.\",\"code\":\"user_global_rate_limited:pro_plus\"}}",
              attempt: 1,
            },
          },
        }),
        promptAsync,
      })
      const task = createRunningTask(sessionID, {
        model: { providerID: "openai", modelID: "gpt-5.6" },
        concurrencyKey: "openai/gpt-5.6",
        concurrencyGroup: "openai/gpt-5.6",
        fallbackChain: [
          { model: "gpt-5.6", providers: ["openai"] },
          { model: "claude-sonnet-4-6", providers: ["anthropic"], variant: "max" },
        ],
        attemptCount: 0,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe(sessionID)
      expect(task.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        variant: "max",
      })
      expect(task.attemptCount).toBe(2)
      expect(promptAsync).toHaveBeenCalledTimes(1)
    })

    test("#when no fallback retry is available #then fails the task and aborts the child session", async () => {
      //#given
      const abort = mock(async () => ({}))
      const promptAsync = mock(async () => ({}))
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-retry-no-fallback": { type: "retry", message: "quota exhausted", attempt: 1 } } }),
        abort,
        promptAsync,
      })
      const task = createRunningTask("ses-retry-no-fallback")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toBe("quota exhausted")
      expect(abort).toHaveBeenCalled()
      expect(promptAsync).not.toHaveBeenCalled()
    })
  })

  describe("#given a running task whose session has terminal non-idle status", () => {
    test('#when session status is "interrupted" #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-interrupted": { type: "interrupted" } } }),
      })
      const task = createRunningTask("ses-interrupted")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test('#when interrupted session has no valid output and fallback is available #then retries through fallback', async () => {
      //#given
      const promptAsync = mock(async () => ({}))
      const onSessionCreated = mock(async () => {})
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-interrupted-no-output": { type: "interrupted" } } }),
        messages: async () => ({ data: [] }),
        promptAsync,
      })
      const task = createRunningTask("ses-interrupted-no-output", {
        model: { providerID: "provider-a", modelID: "original-model" },
        concurrencyKey: "provider-a/original-model",
        concurrencyGroup: "provider-a/original-model",
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
        teamRunId: "team-run-1",
        attemptCount: 0,
        onSessionCreated,
      })
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      await manager.shutdown()

      //#then
      expect(promptAsync).toHaveBeenCalled()
      expect(task.status).toBe("running")
      expect(task.sessionId).toBe("ses-interrupted-no-output")
      expect(task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(task.attemptCount).toBe(1)
      expect(onSessionCreated).toHaveBeenCalledWith("ses-interrupted-no-output", {
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
    })

    test('#when session status is an unknown type #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-unknown": { type: "some-weird-status" } } }),
      })
      const task = createRunningTask("ses-unknown")
      injectTask(manager, task)

      //#when
      const poll = manager["pollRunningTasks"]
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })
  })
})

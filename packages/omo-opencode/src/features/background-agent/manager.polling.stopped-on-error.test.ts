/// <reference types="bun-types" />

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import { MIN_ERRORED_IDLE_POLLS } from "./session-stopped-on-error"
import type { BackgroundTask } from "./types"
import { DEFAULT_STALE_TIMEOUT_MS } from "./constants"

type SessionMessage = {
  info: { role: string; error?: unknown; time?: { created: number } }
  parts: Array<{ type: string; text?: string }>
}

afterEach(() => setSystemTime())

const ERRORED_TURN: SessionMessage[] = [
  { info: { role: "user" }, parts: [{ type: "text", text: "find nothing" }] },
  {
    info: {
      role: "assistant",
      error: { name: "APIError", data: { message: "Rate limit reached for requests", statusCode: 429 } },
    },
    parts: [],
  },
]

function createPluginContext(client: object): PluginInput {
  const directory = tmpdir()
  return {
    project: { id: "test-project", worktree: directory, time: { created: Date.now() } },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {} as PluginInput["$"],
    client: client as PluginInput["client"],
  }
}

function createManager(state: { status: string; messages: SessionMessage[] }, sessionID: string): BackgroundManager {
  const client = {
    session: {
      status: async () => ({ data: { [sessionID]: { type: state.status } } }),
      get: async () => ({ data: { id: sessionID } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({ data: state.messages }),
    },
  }
  return new BackgroundManager({
    pluginContext: createPluginContext(client),
    config: undefined,
    enableParentSessionNotifications: false,
  })
}

function createRunningTask(sessionId: string): BackgroundTask {
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
  }
}

async function pollTimes(manager: BackgroundManager, times: number): Promise<void> {
  const poll = manager["pollRunningTasks"]
  for (let index = 0; index < times; index++) {
    await poll.call(manager)
  }
}

describe("BackgroundManager polling a session that stopped on an error", () => {
  test("#given an idle session ending on an errored turn #when it stays that way #then the task fails with the error", async () => {
    // given
    const state = { status: "idle", messages: ERRORED_TURN }
    const manager = createManager(state, "ses-stopped")
    const task = createRunningTask("ses-stopped")
    manager["tasks"].set(task.id, task)

    // when
    await pollTimes(manager, MIN_ERRORED_IDLE_POLLS)
    await manager.shutdown()

    // then
    expect(task.status).toBe("error")
    expect(task.error).toContain("Rate limit reached for requests")
  })

  test("#given an idle session ending on an errored turn #when fewer polls than the threshold ran #then the task keeps waiting", async () => {
    // given
    const state = { status: "idle", messages: ERRORED_TURN }
    const manager = createManager(state, "ses-grace")
    const task = createRunningTask("ses-grace")
    manager["tasks"].set(task.id, task)

    // when
    await pollTimes(manager, MIN_ERRORED_IDLE_POLLS - 1)
    await manager.shutdown()

    // then
    expect(task.status).toBe("running")
    expect(task.consecutiveErroredIdlePolls).toBe(MIN_ERRORED_IDLE_POLLS - 1)
  })

  test("#given an errored idle session #when a recovery prompt resumes it before the threshold #then the task is not failed", async () => {
    // given
    const recoveryAt = Date.now()
    setSystemTime(new Date(recoveryAt))
    const state = { status: "idle", messages: ERRORED_TURN }
    const manager = createManager(state, "ses-recovered")
    const task = createRunningTask("ses-recovered")
    manager["tasks"].set(task.id, task)
    await pollTimes(manager, MIN_ERRORED_IDLE_POLLS - 1)

    // when
    state.status = "busy"
    state.messages = [
      ...ERRORED_TURN,
      { info: { role: "user", time: { created: recoveryAt } }, parts: [{ type: "text", text: "retry" }] },
    ]
    await pollTimes(manager, 1)
    state.status = "idle"
    setSystemTime(new Date(recoveryAt + 14_999))
    await pollTimes(manager, MIN_ERRORED_IDLE_POLLS - 1)
    await manager.shutdown()

    // then
    expect(task.status).toBe("running")
    expect(task.consecutiveErroredIdlePolls).toBe(0)
  })

  test("#given an unanswered recovery prompt #when the existing output-settle window expires #then the new turn fails without the old error", async () => {
    // given
    const recoveryAt = Date.now()
    setSystemTime(new Date(recoveryAt))
    const state = {
      status: "idle",
      messages: [
        ...ERRORED_TURN,
        { info: { role: "user", time: { created: recoveryAt } }, parts: [{ type: "text", text: "retry" }] },
      ],
    }
    const manager = createManager(state, "ses-recovery-expired")
    const task = createRunningTask("ses-recovery-expired")
    manager["tasks"].set(task.id, task)

    // when
    setSystemTime(new Date(recoveryAt + 15_000))
    await pollTimes(manager, 1)
    await manager.shutdown()

    // then
    expect(task.status).toBe("error")
    expect(task.error).not.toContain("Rate limit reached for requests")
  })

  test("#given a recovery prompt within grace #when its real assistant output arrives #then the task completes", async () => {
    // given
    const recoveryAt = Date.now()
    setSystemTime(new Date(recoveryAt))
    const state: { status: string; messages: SessionMessage[] } = {
      status: "idle",
      messages: [
        ...ERRORED_TURN,
        { info: { role: "user", time: { created: recoveryAt } }, parts: [{ type: "text", text: "retry" }] },
      ],
    }
    const manager = createManager(state, "ses-recovery-output")
    const task = createRunningTask("ses-recovery-output")
    manager["tasks"].set(task.id, task)
    await pollTimes(manager, 1)

    // when
    setSystemTime(new Date(recoveryAt + 14_999))
    state.messages.push({
      info: { role: "assistant", time: { created: recoveryAt + 14_999 } },
      parts: [{ type: "text", text: "recovered result" }],
    })
    await pollTimes(manager, 1)
    await manager.shutdown()

    // then
    expect(task.status).toBe("completed")
  })

  test("#given a session-present TEAM recovery with a held slot #when recovery grace expires #then the task fails and releases its slot without stale teardown", async () => {
    // given
    const recoveryAt = Date.now()
    setSystemTime(new Date(recoveryAt))
    const state = {
      status: "idle",
      messages: [
        ...ERRORED_TURN,
        { info: { role: "user", time: { created: recoveryAt } }, parts: [{ type: "text", text: "retry" }] },
      ],
    }
    const manager = createManager(state, "ses-team-recovery")
    const task = createRunningTask("ses-team-recovery")
    task.teamRunId = "team-recovery"
    task.startedAt = new Date(recoveryAt - DEFAULT_STALE_TIMEOUT_MS - 1)
    task.progress = { toolCalls: 0, lastUpdate: task.startedAt }
    task.concurrencyKey = "openai/gpt-fake"
    task.concurrencyGroup = task.concurrencyKey
    await manager["concurrencyManager"].acquire(task.concurrencyKey)
    manager["tasks"].set(task.id, task)
    setSystemTime(new Date(recoveryAt + 14_999))
    await pollTimes(manager, 1)
    expect(task.status).toBe("running")
    expect(manager["concurrencyManager"].getCount("openai/gpt-fake")).toBe(1)

    // when
    setSystemTime(new Date(recoveryAt + 15_000))
    await pollTimes(manager, 1)
    try {
      // then
      expect(task.status).toBe("error")
      expect(manager["concurrencyManager"].getCount("openai/gpt-fake")).toBe(0)
      expect(task.error).not.toContain("Rate limit reached for requests")
    } finally {
      await manager.shutdown()
    }
  })
})

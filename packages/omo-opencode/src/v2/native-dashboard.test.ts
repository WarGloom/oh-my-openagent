import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, saveRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { removeRuntimeDirectory } from "@oh-my-opencode/team-core/team-state-store/runtime-cleanup"
import { createTask } from "@oh-my-opencode/team-core/team-tasklist"
import { BackgroundManager } from "../features/background-agent"
import { MonitorManager } from "../features/monitor/manager"
import type { ExitResult } from "../features/monitor/process"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { registerNativeDashboard } from "./native-dashboard"
import { createSessionTracker } from "./session-tracker"
import type { BackgroundTask, LaunchInput } from "../features/background-agent/types"
import type { MonitorRecord } from "../features/monitor/types"
import { fixture, cleanupNativeFixtures } from "./native-subagent-jobs-test-fixture"
import type { V2PluginContext } from "./context-types"

test("dashboard actions enforce ownership and status and collapse duplicate requests", async () => {
  const fake = createFakePluginContext()
  const task: BackgroundTask = {
    id: "task",
    parentSessionId: "lead",
    parentMessageId: "msg",
    agent: "explore",
    prompt: "private prompt",
    description: "inspect",
    status: "running",
  }
  const monitor: MonitorRecord = {
    id: "monitor",
    parentSessionId: "lead",
    label: "checks",
    command: "private",
    mode: "idle",
    status: "running",
    startedAt: new Date(),
    counters: {
      totalLines: 0,
      matchedLines: 0,
      unmatchedLines: 0,
      droppedMatched: 0,
      droppedUnmatched: 0,
      bytesDropped: 0,
      lastSequence: 0,
    },
  }
  const cancel = Promise.withResolvers<boolean>()
  let cancelled = 0
  let stopped = 0
  const dashboard = await registerNativeDashboard(fake.context, {
    backgroundManager: {
      getTasksByParentSession: (id) => (id === "lead" ? [task] : []),
      onVisibleChange: () => () => {},
      cancelTask: async (_id, options) => {
        expect(options?.source).toBe("dashboard")
        cancelled++
        return cancel.promise
      },
      launch: async () => {
        throw new Error("unexpected launch")
      },
    },
    monitorManager: {
      list: (id) => (id === "lead" ? [monitor] : []),
      onVisibleChange: () => () => {},
      stop: async () => {
        stopped++
        monitor.status = "stopped"
      },
    },
  })
  try {
    for (const sessionID of ["foreign", "child"]) {
      await expect(dashboard.cancelTask({ sessionID, taskID: task.id })).rejects.toThrow("session")
      await expect(dashboard.retryTask({ sessionID, taskID: task.id })).rejects.toThrow("session")
      await expect(dashboard.stopMonitor({ sessionID, monitorID: monitor.id })).rejects.toThrow("session")
    }
    for (const status of ["completed", "error", "cancelled", "interrupt"] as const) {
      task.status = status
      await expect(dashboard.cancelTask({ sessionID: "lead", taskID: task.id })).rejects.toThrow("status")
    }
    for (const status of ["exited", "stopped", "failed"] as const) {
      monitor.status = status
      await expect(dashboard.stopMonitor({ sessionID: "lead", monitorID: monitor.id })).rejects.toThrow("status")
    }
    task.status = "pending"
    const first = dashboard.cancelTask({ sessionID: "lead", taskID: task.id })
    const second = dashboard.cancelTask({ sessionID: "lead", taskID: task.id })
    cancel.resolve(true)
    await Promise.all([first, second])
    expect(cancelled).toBe(1)
    monitor.status = "starting"
    await Promise.all([
      dashboard.stopMonitor({ sessionID: "lead", monitorID: monitor.id }),
      dashboard.stopMonitor({ sessionID: "lead", monitorID: monitor.id }),
    ])
    expect(stopped).toBe(1)
  } finally {
    cancel.resolve(true)
    await dashboard.dispose()
  }
})

test.each(["cancel", "stop"] as const)("%s shares in-flight failures and permits later actions", async (action) => {
  const fake = createFakePluginContext()
  const task: BackgroundTask = {
    id: "task",
    parentSessionId: "lead",
    parentMessageId: "msg",
    agent: "worker",
    prompt: "work",
    description: "work",
    status: "running",
  }
  const monitor: MonitorRecord = {
    id: "monitor",
    parentSessionId: "lead",
    label: "watch",
    command: "watch",
    mode: "idle",
    status: "running",
    startedAt: new Date(),
    counters: {
      totalLines: 0,
      matchedLines: 0,
      unmatchedLines: 0,
      droppedMatched: 0,
      droppedUnmatched: 0,
      bytesDropped: 0,
      lastSequence: 0,
    },
  }
  const pending = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let calls = 0
  const run = async () => {
    calls++
    entered.resolve()
    if (calls === 1) await pending.promise
  }
  const dashboard = await registerNativeDashboard(fake.context, {
    backgroundManager: {
      getTasksByParentSession: () => [task],
      onVisibleChange: () => () => {},
      cancelTask: async () => {
        await run()
        task.status = "cancelled"
        return true
      },
    },
    monitorManager: {
      list: () => [monitor],
      onVisibleChange: () => () => {},
      stop: async () => {
        await run()
        monitor.status = "stopped"
      },
    },
  })
  const invoke = () =>
    action === "cancel"
      ? dashboard.cancelTask({ sessionID: "lead", taskID: task.id })
      : dashboard.stopMonitor({ sessionID: "lead", monitorID: monitor.id })
  try {
    const first = invoke()
    await entered.promise
    const second = invoke()
    const outcomes = Promise.allSettled([first, second])
    pending.reject(new Error("action failed"))
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"])
    await invoke()
    task.status = "running"
    monitor.status = "running"
    await invoke()
    expect(calls).toBe(3)
  } finally {
    await dashboard.dispose()
  }
})

test("native continuation disables retry in its dashboard row and RPC action", async () => {
  const fake = createFakePluginContext()
  const task: BackgroundTask = {
    id: "continued",
    parentSessionId: "lead",
    parentMessageId: "message",
    agent: "worker",
    prompt: "followup",
    description: "work",
    status: "error",
  }
  task.nativeContinued = true
  const dashboard = await registerNativeDashboard(fake.context, {
    backgroundManager: { getTasksByParentSession: () => [task], onVisibleChange: () => () => {} },
  })
  try {
    const row = (await dashboard.get({ sessionID: "lead" }))?.tasks.rows.find((item) => item.id === task.id)
    expect(row?.retryable).toBe(false)
    await expect(dashboard.retryTask({ sessionID: "lead", taskID: task.id })).rejects.toThrow(
      "Retry is unavailable for continued tasks",
    )
  } finally {
    await dashboard.dispose()
  }
})

test.each(["error", "cancelled", "interrupt"] as const)(
  "retry preserves tool launch inputs after %s without changing the old task",
  async (status) => {
    const fake = createFakePluginContext()
    const task: BackgroundTask = {
      id: "old",
      parentSessionId: "lead",
      parentMessageId: "message",
      status: "error",
      agent: "worker",
      category: "deep",
      model: { providerID: "mock", modelID: "failure", variant: "high" },
      skills: ["programming"],
      prompt: "retained prompt",
      description: "retained description",
      skillContent: "retained skill",
      parentAgent: "sisyphus",
      parentModel: { providerID: "mock", modelID: "parent" },
      parentTools: { bash: false },
      cwd: "/project",
      userPermission: { bash: "deny" },
      error: "model failed",
      nativeCompletion: "none",
      nativeMode: "foreground",
      nativeInvocation: { kind: "tool", agent: "sisyphus", messageID: "message", toolCallID: "call" },
    }
    const launched: LaunchInput[] = []
    const dashboard = await registerNativeDashboard(fake.context, {
      backgroundManager: {
        getTasksByParentSession: (id) => (id === "lead" ? [task] : []),
        onVisibleChange: () => () => {},
        cancelTask: async () => false,
        launch: async (input) => {
          launched.push(input)
          return { ...task, id: `new-${launched.length}`, status: "pending" }
        },
      },
    })
    try {
      for (const status of ["pending", "running", "completed"] as const) {
        task.status = status
        await expect(dashboard.retryTask({ sessionID: "lead", taskID: task.id })).rejects.toThrow("status")
      }
      task.status = status
      task.teamRunId = "team"
      await expect(dashboard.retryTask({ sessionID: "lead", taskID: task.id })).rejects.toThrow("team")
      delete task.teamRunId
      const before = structuredClone(task)
      const ids = await Promise.all([
        dashboard.retryTask({ sessionID: "lead", taskID: task.id }),
        dashboard.retryTask({ sessionID: "lead", taskID: task.id }),
      ])
      expect(ids).toEqual([{ taskID: "new-1" }, { taskID: "new-1" }])
      expect(launched).toEqual([
        {
          agent: task.agent,
          category: task.category,
          model: task.model,
          skills: task.skills,
          prompt: task.prompt,
          description: task.description,
          parentSessionId: "lead",
          parentMessageId: "message",
          skillContent: task.skillContent,
          parentAgent: task.parentAgent,
          parentModel: task.parentModel,
          parentTools: task.parentTools,
          cwd: task.cwd,
          userPermission: task.userPermission,
          nativeCompletion: "parent",
          nativeMode: "background",
          nativeInvocation: task.nativeInvocation,
          nativeTaskKey: `dashboard-retry:${task.id}`,
        },
      ])
      expect(task).toEqual(before)
    } finally {
      await dashboard.dispose()
    }
  },
)

test.each(["error", "cancelled", "interrupt"] as const)(
  "retry rejects command provenance after %s before launch",
  async (status) => {
    const fake = createFakePluginContext()
    const task: BackgroundTask = {
      id: "command",
      parentSessionId: "lead",
      parentMessageId: "message",
      agent: "worker",
      description: "command task",
      prompt: "retained",
      status,
      nativeInvocation: { kind: "command", agent: "sisyphus", command: "review", invocationID: "expired" },
    }
    let launches = 0
    const dashboard = await registerNativeDashboard(fake.context, {
      backgroundManager: {
        getTasksByParentSession: () => [task],
        onVisibleChange: () => () => {},
        launch: async () => {
          launches++
          return { ...task, id: "retry" }
        },
      },
    })
    try {
      await expect(dashboard.retryTask({ sessionID: "lead", taskID: task.id })).rejects.toThrow(
        "Retry is unavailable for command-launched tasks",
      )
      expect(launches).toBe(0)
      delete task.nativeInvocation
      expect(await dashboard.retryTask({ sessionID: "lead", taskID: task.id })).toEqual({ taskID: "retry" })
      expect(launches).toBe(1)
    } finally {
      await dashboard.dispose()
    }
  },
)

test("retry creates a distinct task through the native manager's invocation deduplication", async () => {
  const f = await fixture()
  const dashboard = await registerNativeDashboard(f.context, { backgroundManager: f.manager })
  try {
    const started = f.nextStart()
    const original = await f.manager.launch(f.launch("call"))
    await started
    const failed = Promise.withResolvers<void>()
    const off = f.manager.onVisibleChange(() => {
      if (f.manager.getTask(original.id)?.status === "error") failed.resolve()
    })
    try {
      if (!original.nativeAdmissionID) throw new Error("Missing native admission")
      f.finish(original.nativeAdmissionID, "error")
      await failed.promise
    } finally {
      off()
    }
    const next = await dashboard.retryTask({ sessionID: "parent", taskID: original.id })
    expect(next.taskID).not.toBe(original.id)
    const rows = f.manager.getTasksByParentSession("parent")
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === next.taskID)?.nativeInvocation).toEqual(original.nativeInvocation)
  } finally {
    await dashboard.dispose()
    await cleanupNativeFixtures()
  }
})

test("command retry returns its declared RPC error instead of a hidden internal error", async () => {
  const fake = createFakePluginContext()
  const response = Promise.withResolvers<unknown>()
  const context: V2PluginContext = {
    ...fake.context,
    rpc: {
      register: async (definition, handlers) => {
        const registration = await fake.context.rpc.register(definition, handlers)
        const retry: unknown = Reflect.get(handlers, "retryTask")
        if (typeof retry !== "function") throw new Error("Retry handler missing")
        response.resolve(
          Reflect.apply(retry, undefined, [
            { sessionID: "lead", taskID: "command" },
            {
              signal: new AbortController().signal,
              error: (type: string, message: string) => {
                const schema = definition.methods.retryTask?.errors?.[type]
                if (!schema) throw new Error("RPC error must be declared")
                schema.parse(undefined)
                return { type, message }
              },
            },
          ]),
        )
        return registration
      },
    },
  }
  const task: BackgroundTask = {
    id: "command",
    parentSessionId: "lead",
    parentMessageId: "m",
    agent: "worker",
    description: "command failure",
    prompt: "retained",
    status: "error",
    nativeInvocation: { kind: "command", agent: "sisyphus", command: "review", invocationID: "expired" },
  }
  const dashboard = await registerNativeDashboard(context, {
    backgroundManager: {
      getTasksByParentSession: () => [task],
      onVisibleChange: () => () => {},
    },
  })
  try {
    expect(await response.promise).toEqual({
      type: "unavailable",
      message: "Retry is unavailable for command-launched tasks",
    })
  } finally {
    await dashboard.dispose()
  }
})

test("real task, monitor and team commits invalidate scoped snapshots; removed teams notify prior members", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dashboard-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: root })
  const fake = createFakePluginContext({ directory: root })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const background = new BackgroundManager({ pluginContext: input, enableParentSessionNotifications: false })
  const exit = Promise.withResolvers<ExitResult>()
  const monitor = new MonitorManager({
    pluginContext: input,
    deps: {
      spawnMonitoredProcess: () => ({
        stdout: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        exited: exit.promise,
        kill: () => {
          exit.resolve({ code: 0, signal: null })
        },
      }),
      createInjector: () => ({ queueBatch: () => {}, flushMonitor: async () => {} }),
      registerManagerForCleanup: () => {},
      unregisterManagerForCleanup: () => {},
    },
  })
  const controller = new AbortController()
  const stream = fake.context.event
    .subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
    [Symbol.asyncIterator]()
  const reset = stream.next()
  const dashboard = await registerNativeDashboard(fake.context, {
    backgroundManager: background,
    monitorManager: monitor,
    teamModeConfig: config,
  })
  try {
    await reset
    await dashboard.get({ sessionID: "lead" })
    await dashboard.get({ sessionID: "member" })
    const first = stream.next()
    const task = await background.trackTask({
      taskId: "task",
      sessionId: "child",
      parentSessionId: "lead",
      description: "inspect",
    })
    const watched = await monitor.start({ command: "controlled", label: "checks", parentSessionId: "lead" })
    const spec = TeamSpecSchema.parse({
      name: "visible",
      members: [{ name: "worker", kind: "subagent_type", subagent_type: "sisyphus" }],
    })
    const team = await createRuntimeState(spec, "lead", "project", config)
    await saveRuntimeState(
      { ...team, members: team.members.map((member) => ({ ...member, sessionId: "member" })) },
      config,
    )
    await createTask(
      team.teamRunId,
      { subject: "work", description: "private", status: "pending", blocks: [], blockedBy: [] },
      config,
    )
    expect(await first).toMatchObject({
      value: { type: "rpc.omo.dashboard.changed", data: { revision: 2, sessionIDs: ["lead", "member"] } },
    })
    const before = await dashboard.get({ sessionID: "lead" })
    expect(before?.tasks.counts.running).toBe(1)
    expect(before?.monitors.counts.running).toBe(1)
    expect(before?.teams[0]?.tasks.pending).toBe(1)
    const terminal = stream.next()
    task.status = "interrupt"
    exit.resolve({ code: 7, signal: null })
    expect(await terminal).toMatchObject({ value: { data: { revision: 3, sessionIDs: ["lead"] } } })
    const after = await dashboard.get({ sessionID: "lead" })
    expect(after?.tasks.counts.interrupt).toBe(1)
    expect(after?.monitors.rows).toEqual([{ id: watched.id, label: "checks", status: "exited", exitCode: 7 }])
    const removed = stream.next()
    await removeRuntimeDirectory(team.teamRunId, config)
    expect(await removed).toMatchObject({ value: { data: { revision: 4, sessionIDs: ["lead", "member"] } } })
    expect((await dashboard.get({ sessionID: "member" }))?.teams).toEqual([])
    const unrelated = await createRuntimeState({ ...spec, name: "unrelated" }, "outside", "project", config)
    await saveRuntimeState({ ...unrelated, status: "active" }, config)
  } finally {
    await dashboard.dispose()
    controller.abort()
    await monitor.shutdown()
    background.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import { createManagers, type Managers } from "../create-managers"
import { createRuntimeTmuxConfig } from "../create-runtime-tmux-config"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { createPluginDispose } from "../plugin-dispose"
import { createModelCacheState } from "../plugin-state"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"
import type { V2StorageDomain, V2SyntheticInput } from "./context-types"
import { BackgroundManager } from "../features/background-agent/manager"
import { backgroundTaskRecord, encodeBackgroundTask } from "./background-task-record"
import {
  fixture as nativeFixture,
  cleanups as nativeCleanups,
  cleanupNativeFixtures,
} from "./native-subagent-jobs-test-fixture"
import { V2BackgroundLifecycle } from "./background-lifecycle"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await cleanupNativeFixtures()
  clearBackgroundTaskRegistryForTesting()
})

async function fixture() {
  const start = V2BackgroundLifecycle.prototype.start
  let recovery: Promise<void> | undefined
  const starting = spyOn(V2BackgroundLifecycle.prototype, "start").mockImplementation(function (signal) {
    recovery = start.call(this, signal)
    return recovery
  })
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-native-"))
  const oldDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = join(directory, "data")
  const fake = createFakePluginContext({
    directory,
    sessionAgent: "Sisyphus",
    sessionInfo: { parentID: "parent", model: { providerID: "openai", id: "gpt-6.1-sol" } },
  })
  let childIdle = false
  let childRemoved = false
  const originalGet = fake.context.session.get
  const get = spyOn(fake.context.session, "get").mockImplementation(async (input) => {
    if (childRemoved && input.sessionID === "child")
      throw Object.assign(new Error("session removed"), { _tag: "SessionNotFoundError" })
    return {
      ...(await originalGet(input)),
      ...(input.sessionID === "parent" ? { parentID: undefined } : {}),
      ...(childIdle && input.sessionID === "child" ? { time: { created: 1, updated: 3, busy: 2, idle: 3 } } : {}),
    }
  })
  const promptWaiters: Array<() => void> = []
  const originalPrompt = fake.context.session.prompt
  const prompt = spyOn(fake.context.session, "prompt").mockImplementation(async (input) => {
    await originalPrompt(input)
    promptWaiters.shift()?.()
  })
  const nextPrompt = () =>
    new Promise<void>((resolve) => {
      promptWaiters.push(resolve)
    })
  const disk = new Map<string, Parameters<V2StorageDomain["set"]>[1]>()
  const storage: V2StorageDomain = {
    get: async (key) => structuredClone(disk.get(key)),
    set: async (key, value) => {
      disk.set(key, structuredClone(value))
    },
    remove: async (key) => {
      disk.delete(key)
    },
    scan: async ({ prefix }) => ({
      entries: [...disk]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    }),
  }
  const notices = new Map<string, V2SyntheticInput>()
  const synthetic = spyOn(fake.context.session, "synthetic").mockImplementation(async (input) => {
    if (input.id && !notices.has(input.id)) notices.set(input.id, input)
  })
  const generations: Managers[] = []
  const cleanupManagers: Array<{ shutdown: () => void | Promise<void> }> = []
  const config = OhMyOpenCodeConfigSchema.parse({
    tui: { sidebar: { enabled: false } },
    background_task: { defaultConcurrency: 1 },
  })
  const setup = createV2Setup({
    serverPlugin: async (input) => {
      const managers = createManagers({
        ctx: input,
        pluginConfig: config,
        tmuxConfig: createRuntimeTmuxConfig(config),
        modelCacheState: createModelCacheState(),
        backgroundNotificationHookEnabled: true,
        deps: {
          registerManagerForCleanupFn: (manager) => {
            cleanupManagers.push(manager)
          },
        },
      })
      generations.push(managers)
      return {
        event: async ({ event }) => {
          managers.backgroundManager.handleEvent(event)
        },
        dispose: createPluginDispose({ ...managers, disposeHooks: () => {} }),
      }
    },
  })
  const context = { ...fake.context, storage }
  let dispose = await setup(context)
  await recovery
  const manager = () => {
    const current = generations.at(-1)?.backgroundManager
    if (!current) throw new Error("background manager missing")
    return current
  }
  cleanups.push(async () => {
    await dispose()
    starting.mockRestore()
    for (const cleanup of cleanupManagers) await cleanup.shutdown()
    synthetic.mockRestore()
    get.mockRestore()
    prompt.mockRestore()
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldDataHome
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    fake,
    disk,
    synthetic,
    notices,
    manager,
    nextPrompt,
    setChildIdle: () => {
      childIdle = true
    },
    removeChild: () => {
      childRemoved = true
    },
    track: async () =>
      manager().trackTask({
        taskId: "bg_native",
        sessionId: "child",
        parentSessionId: "parent",
        agent: "Sisyphus",
        description: "native task",
        concurrencyKey: "openai/gpt-6.1-sol",
      }),
    reload: async (restart = false) => {
      const persisted = structuredClone(disk)
      await dispose()
      if (restart) {
        clearBackgroundTaskRegistryForTesting()
        disk.clear()
        for (const [key, value] of persisted) disk.set(key, value)
      }
      dispose = await setup(context)
      await recovery
    },
    reloadOverlapping: async () => {
      const oldDispose = dispose
      dispose = await setup(context)
      await recovery
      await oldDispose()
    },
    parentNotices: () => [...notices.values()].filter((notice) => notice.sessionID === "parent"),
  }
}

describe("V2 durable background lifecycle", () => {
  it.each([false, true])(
    "#given a running task #when the plugin reloads with overlapping generations=%s #then it stays running and completes once",
    async (overlapping) => {
      // given
      const f = await fixture()
      await f.track()
      // when
      if (overlapping) await f.reloadOverlapping()
      else await f.reload()
      expect(f.manager().findBySession("child")?.status).toBe("running")
      await f.fake.triggerIdle({ sessionID: "child", background: [] })
      await f.fake.triggerIdle({ sessionID: "child", background: [] })
      // then
      expect(f.fake.sessionCalls.filter((call) => call.kind === "interrupt")).toEqual([])
      expect(f.parentNotices()).toHaveLength(1)
      expect(f.manager().getTask("bg_native")?.status).toBe("completed")
      expect(f.synthetic.mock.calls).toHaveLength(1)
    },
  )

  it("#given a durable child record #when host memory is lost #then setup rebuilds the same task and wakes recovered work", async () => {
    // given
    const f = await fixture()
    await f.track()
    expect(f.disk.size).toBe(1)
    // when
    await f.reload(true)
    // then
    expect(f.manager().getTask("bg_native")).toMatchObject({
      status: "running",
      parentSessionId: "parent",
      model: { providerID: "openai", modelID: "gpt-6.1-sol" },
    })
    expect(f.manager().getTask("bg_native")?.startedAt).toBeInstanceOf(Date)
    expect([...f.notices.values()].map((notice) => notice.sessionID)).toEqual(["child"])
    await f.fake.triggerIdle({ sessionID: "child", background: [] })
    expect(f.parentNotices()).toHaveLength(1)
  })

  it("#given a child with a background shell #when it goes idle #then only the final native idle completes it", async () => {
    // given
    const f = await fixture()
    const task = await f.track()
    task.startedAt = new Date(Date.now() - 10_000)
    const contextRead = spyOn(f.fake.context.session, "context")
    try {
      // when
      f.manager().handleEvent({ type: "session.idle", properties: { sessionID: "child" } })
      // then
      expect(contextRead).not.toHaveBeenCalled()
      await f.fake.triggerIdle({
        sessionID: "child",
        background: [{ kind: "shell", sessionID: "child", shellID: "shell_1", command: "build" }],
      })
      expect(f.manager().getTask("bg_native")?.status).toBe("running")
      expect(f.parentNotices()).toEqual([])
      await f.fake.triggerIdle({ sessionID: "child", background: [] })
      expect(f.manager().getTask("bg_native")?.status).toBe("completed")
      expect(f.parentNotices()).toHaveLength(1)
    } finally {
      contextRead.mockRestore()
    }
  })

  it("#given parent admission succeeds before a crash #when setup retries the durable completion #then the same native ID admits one notice", async () => {
    // given
    const f = await fixture()
    await f.track()
    const accept = f.synthetic.getMockImplementation()
    f.synthetic.mockImplementationOnce(async (input) => {
      await accept?.(input)
      throw new Error("host stopped after admission")
    })
    // when
    await f.fake.triggerIdle({ sessionID: "child", background: [] })
    await f.reload(true)
    // then
    expect(f.parentNotices()).toHaveLength(1)
    expect(f.synthetic.mock.calls.map(([input]) => input.id)).toEqual([
      f.parentNotices()[0]?.id,
      f.parentNotices()[0]?.id,
    ])
    expect(f.manager().getTask("bg_native")?.status).toBe("completed")
  })

  it("#given an active parent with no visible reply yet #when completion and reload occur #then native admission keeps one notice", async () => {
    // given
    const f = await fixture()
    await f.track()
    f.manager().handleEvent({ type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } })
    // when
    await f.fake.triggerIdle({ sessionID: "child", background: [] })
    await f.reload(true)
    // then
    expect(f.parentNotices()).toHaveLength(1)
    expect(f.synthetic.mock.calls).toHaveLength(1)
  })

  it("#given a queued launch #when host memory is lost #then its original ID starts after the recovered running task completes", async () => {
    // given
    const f = await nativeFixture()
    const admitted = f.nextStart()
    const first = await f.manager.launch(f.launch("first"))
    await admitted
    const queued = await f.manager.launch(f.launch("queued"))
    expect(f.manager.getTask(queued.id)?.status).toBe("pending")
    // when
    await f.manager.shutdown()
    const persisted = [...f.stored.values()].map((record) => backgroundTaskRecord.parse(record))
    clearBackgroundTaskRegistryForTesting()
    const manager = new BackgroundManager({
      pluginContext: f.input,
      config: { defaultConcurrency: 1 },
      nativeJobs: f.createJobs(),
      nativeLifecycle: {
        save: async (task) => {
          f.stored.set(task.id, encodeBackgroundTask(task))
        },
        notify: async (task) => {
          f.notices.push(task.id)
        },
      },
      preserveSessionsOnShutdown: true,
    })
    nativeCleanups.push(() => manager.shutdown())
    for (const task of persisted) manager.adoptRetainedTask(task)
    await manager.restoreNativeJobs()
    expect(manager.getTask(queued.id)?.status).toBe("pending")
    const nextAdmission = f.nextStart()
    const running = manager.getTask(first.id)
    if (!running?.nativeAdmissionID) throw new Error("recovered native admission missing")
    const completed = manager.waitForNativeTask(first.id, new AbortController().signal)
    f.finish(running.nativeAdmissionID)
    await nextAdmission
    await completed
    // then
    expect(manager.getTask(queued.id)?.status).toBe("running")
    expect(
      manager
        .getTasksByParentSession("parent")
        .map((task) => task.id)
        .sort(),
    ).toEqual([first.id, queued.id].sort())
    expect(manager.getTask(first.id)?.sessionId).toBe(first.sessionId)
    expect(manager.getTask(queued.id)?.sessionId).toBe(queued.sessionId)
  })

  it("#given the child finishes while the plugin is absent #when setup sees native idle state #then it requests a fresh native completion boundary", async () => {
    // given
    const f = await fixture()
    await f.track()
    f.setChildIdle()
    // when
    await f.reload()
    await f.fake.triggerIdle({ sessionID: "child", background: [] })
    // then
    expect([...f.notices.values()].map((notice) => notice.sessionID)).toEqual(["child", "parent"])
    expect(f.manager().getTask("bg_native")?.status).toBe("completed")
  })

  it("#given the host deleted a child #when the plugin reloads #then stale private state cannot resurrect its task", async () => {
    // given
    const f = await fixture()
    await f.track()
    f.removeChild()
    // when
    await f.reload()
    // then
    expect(f.manager().getRunningTasks()).toEqual([])
    expect(f.disk.size).toBe(0)
  })
})

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { BackgroundManager } from "../features/background-agent/manager"
import type { V2StorageDomain } from "./context-types"
import { getV2BackgroundJobs, getV2BackgroundLifecycle } from "./create-plugin-input"
import { createV2Setup } from "./create-v2-setup"
import { cleanupNativeFixtures, cleanups, fixture } from "./native-subagent-jobs-test-fixture"

afterEach(cleanupNativeFixtures)

const IDLE = { created: 1, updated: 3, busy: 2, idle: 3 }
const BUSY = { created: 1, updated: 3, busy: 3, idle: 2 }

// The host resumes a plugin-admitted child through `ready` but adds no restart notice, so the recovery path must.
async function restartedChild(options: { readonly childTime: typeof IDLE; readonly failNotice?: boolean }) {
  const f = await fixture({ activate: async () => ({ text: "", activationIDs: [], selections: [] }) })
  const started = f.nextStart()
  const task = await f.manager.launch(f.launch("interrupted"))
  await started
  await f.manager.shutdown()
  const disk = new Map(
    [...f.stored].map(([id, record]) => [
      `background-task/${encodeURIComponent(f.context.location.directory)}/${id}`,
      structuredClone(record),
    ]),
  )
  const storage: V2StorageDomain = {
    get: async (key) => structuredClone(disk.get(key)),
    set: async (key, value) => void disk.set(key, structuredClone(value)),
    remove: async (key) => void disk.delete(key),
    scan: async ({ prefix }) => ({
      entries: [...disk].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  }
  const events: string[] = []
  const resumed = Promise.withResolvers<void>()
  const get = f.context.session.get
  cleanups.push(
    (() => {
      const session = spyOn(f.context.session, "get").mockImplementation(async (input) => ({
        ...(await get(input)),
        ...(input.sessionID === task.sessionId ? { parentID: "parent", time: options.childTime } : {}),
      }))
      return () => session.mockRestore()
    })(),
  )
  const synthetic = f.context.session.synthetic
  cleanups.push(
    (() => {
      const spy = spyOn(f.context.session, "synthetic").mockImplementation(async (input) => {
        if (input.sessionID !== task.sessionId) return synthetic(input)
        events.push(`synthetic:${input.metadata?.notice}`)
        if (options.failNotice) throw new Error("inbox unavailable")
        return synthetic(input)
      })
      return () => spy.mockRestore()
    })(),
  )
  const subagent = {
    ...f.domain,
    ready: async (input: Parameters<typeof f.domain.ready>[0]) => {
      events.push("ready")
      const receipt = await f.domain.ready(input)
      resumed.resolve()
      return receipt
    },
  }
  const context = {
    ...f.context,
    storage,
    agent: {
      ...f.context.agent,
      list: async () => ({
        data: ["worker", "parent-agent"].map((id) => ({
          id,
          name: id,
          mode: "subagent" as const,
          hidden: false,
          permissions: [],
        })),
      }),
    },
    experimental: { ...f.context.experimental, subagent },
  }
  const setup = createV2Setup({
    serverPlugin: async (input) => {
      const lifecycle = getV2BackgroundLifecycle(input)
      const manager = new BackgroundManager({
        pluginContext: input,
        nativeJobs: getV2BackgroundJobs(input),
        nativeLifecycle: lifecycle,
        preserveSessionsOnShutdown: true,
      })
      lifecycle?.connect(manager)
      return { dispose: () => manager.shutdown() }
    },
  })
  const activate = async () => {
    const cleanup = await setup(context)
    cleanups.push(cleanup)
    await resumed.promise
    return cleanup
  }
  return { f, task, events, activate, notices: () => f.fake.sessionCalls.filter((call) => call.kind === "synthetic") }
}

describe("restart notice for recovered native children", () => {
  it("#given a busy child and a host restart #when the plugin recovers it #then the notice precedes the single resume", async () => {
    // given
    const { f, task, events, activate, notices } = await restartedChild({ childTime: BUSY })
    clearBackgroundTaskRegistryForTesting()
    // when
    await activate()
    // then
    expect(events).toEqual(["synthetic:restart", "ready"])
    expect(notices()).toEqual([
      {
        kind: "synthetic",
        input: expect.objectContaining({
          sessionID: task.sessionId,
          metadata: { notice: "restart" },
          resume: false,
          text: expect.stringContaining("The server restarted while you were working."),
        }),
      },
    ])
    expect(f.ready).toHaveLength(1)
  })

  it("#given a plugin reload without a host restart #when it recovers the child #then no notice is added", async () => {
    // given the registry of the live process still holds the task
    const { events, activate } = await restartedChild({ childTime: BUSY })
    // when
    await activate()
    // then
    expect(events).toEqual(["ready"])
  })

  it("#given a child that was idle before the restart #when the plugin recovers it #then no notice is added", async () => {
    // given
    const { events, activate } = await restartedChild({ childTime: IDLE })
    clearBackgroundTaskRegistryForTesting()
    // when
    await activate()
    // then
    expect(events).toEqual(["ready"])
  })

  it("#given the notice cannot be admitted #when the plugin recovers the child #then the child still resumes", async () => {
    // given
    const { f, events, activate } = await restartedChild({ childTime: BUSY, failNotice: true })
    clearBackgroundTaskRegistryForTesting()
    // when
    await activate()
    // then
    expect(events).toEqual(["synthetic:restart", "ready"])
    expect(f.ready).toHaveLength(1)
  })
})

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { V2BackgroundLifecycle } from "./background-lifecycle"
import { cleanupNativeFixtures, fixture, cleanups } from "./native-subagent-jobs-test-fixture"
import { encodeBackgroundTask } from "./background-task-record"
import { BackgroundManager } from "../features/background-agent/manager"

afterEach(cleanupNativeFixtures)

describe("recovered agent visibility", () => {
  it("#given one task lookup fails #when recovery starts #then it still waits for the other task", async () => {
    // given
    const f = await fixture()
    const started = f.nextStart()
    const launched = await f.manager.launch(f.launch("healthy-peer"))
    await started
    const task = f.manager.getTask(launched.id)
    if (!task) throw new Error("healthy task missing")
    await f.manager.shutdown()
    const listed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const context = {
      ...f.context,
      agent: {
        ...f.context.agent,
        list: async () => {
          listed.resolve()
          await release.promise
          return {
            data: [
              { id: "worker", name: "worker", mode: "subagent" as const, hidden: false, permissions: [] },
              { id: "parent-agent", name: "parent", mode: "primary" as const, hidden: false, permissions: [] },
            ],
          }
        },
      },
      session: {
        ...f.context.session,
        get: async (input: { readonly sessionID: string }) => ({
          ...(await f.context.session.get(input)),
          parentID: task.parentSessionId,
        }),
      },
    }
    const lifecycle = new V2BackgroundLifecycle(context, {
      ...f.fake.context.storage,
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({
        entries: [
          {
            key: "poison",
            value: encodeBackgroundTask({ ...task, id: "poison", sessionId: "poison-child", attempts: [] }),
          },
          { key: "healthy", value: encodeBackgroundTask(task) },
        ],
      }),
    })
    await lifecycle.load()
    const manager = new BackgroundManager({
      pluginContext: f.input,
      nativeJobs: f.createJobs(),
      nativeLifecycle: lifecycle,
      preserveSessionsOnShutdown: true,
    })
    cleanups.push(() => manager.shutdown())
    lifecycle.connect(manager)
    const poison = manager.getTask("poison")
    if (!poison) throw new Error("poison task missing")
    let first = true
    Object.defineProperty(poison, "agent", {
      configurable: true,
      get: () => {
        if (first) {
          first = false
          throw new Error("task lookup failed")
        }
        return "worker"
      },
    })
    // when
    const restoring = lifecycle.start()
    try {
      const result = await Promise.race([listed.promise.then(() => "waiting"), restoring.then(() => "restored")])
      // then
      expect(result).toBe("waiting")
      expect(f.ready).toEqual([])
    } finally {
      release.resolve()
      await restoring
      await lifecycle.dispose()
    }
  })

  it("#given the parent changed agents #when recovery starts #then it waits for the admission agent", async () => {
    // given
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch(f.launch("admission-agent"))
    await started
    await f.manager.shutdown()
    const secondList = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const context = {
      ...f.context,
      agent: {
        ...f.context.agent,
        list: async () => {
          calls++
          if (calls === 2) {
            secondList.resolve()
            await release.promise
          }
          return {
            data: [
              { id: "worker", name: "worker", mode: "subagent" as const, hidden: false, permissions: [] },
              {
                id: calls === 1 ? "current-agent" : "parent-agent",
                name: "parent",
                mode: "primary" as const,
                hidden: false,
                permissions: [],
              },
            ],
          }
        },
      },
      session: {
        ...f.context.session,
        get: async (input: { readonly sessionID: string }) => ({
          ...(await f.context.session.get(input)),
          ...(input.sessionID === task.sessionId ? { parentID: task.parentSessionId } : { agent: "current-agent" }),
        }),
      },
    }
    const lifecycle = new V2BackgroundLifecycle(context, {
      ...f.fake.context.storage,
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [{ key: "task", value: encodeBackgroundTask(task) }] }),
    })
    await lifecycle.load()
    const manager = new BackgroundManager({
      pluginContext: f.input,
      nativeJobs: f.createJobs(),
      nativeLifecycle: lifecycle,
      preserveSessionsOnShutdown: true,
    })
    cleanups.push(() => manager.shutdown())
    lifecycle.connect(manager)
    // when
    const restoring = lifecycle.start()
    try {
      const result = await Promise.race([secondList.promise.then(() => "waiting"), restoring.then(() => "restored")])
      // then
      expect(result).toBe("waiting")
      expect(f.ready).toEqual([])
    } finally {
      release.resolve()
      await restoring
      await lifecycle.dispose()
    }
    expect(f.ready).toEqual(["1"])
  })

  it.each(["visible", "timeout", "dispose", "parent-error", "list-error"] as const)(
    "settles recovery after agent readiness ends with %s",
    async (outcome) => {
      // given a running job whose child agent is owned by a later plugin
      const f = await fixture()
      const started = f.nextStart()
      const task = await f.manager.launch(f.launch("late-agent"))
      await started
      await f.manager.shutdown()
      const listed = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let checks = 0
      let available = false
      let parentReads = 0
      const now = Date.now()
      const clock = spyOn(Date, "now").mockImplementation(() => now)
      const context = {
        ...f.context,
        agent: {
          ...f.context.agent,
          list: async () => {
            checks++
            if (outcome === "list-error" && checks === 1) throw new Error("registry temporarily unavailable")
            if (outcome === "timeout") clock.mockImplementation(() => now + 10_001)
            if (checks === 2 || outcome === "timeout" || outcome === "dispose") {
              listed.resolve()
              await release.promise
            }
            const result = await f.context.agent.list()
            return {
              ...result,
              data: available
                ? [
                    { id: "worker", name: "worker", mode: "subagent" as const, hidden: false, permissions: [] },
                    {
                      id: "parent-agent",
                      name: "parent-agent",
                      mode: "primary" as const,
                      hidden: false,
                      permissions: [],
                    },
                  ]
                : [],
            }
          },
        },
        session: {
          ...f.context.session,
          get: async (input: { readonly sessionID: string }) => {
            if (input.sessionID === task.parentSessionId && outcome === "parent-error" && parentReads++ === 0)
              throw new Error("parent lookup temporarily unavailable")
            return {
              ...(await f.context.session.get(input)),
              ...(input.sessionID === task.sessionId ? { parentID: task.parentSessionId } : {}),
            }
          },
        },
      }
      const lifecycle = new V2BackgroundLifecycle(context, {
        ...f.fake.context.storage,
        get: async () => undefined,
        set: async () => {},
        remove: async () => {},
        scan: async () => ({ entries: [{ key: "task", value: encodeBackgroundTask(task) }] }),
      })
      await lifecycle.load()
      const manager = new BackgroundManager({
        pluginContext: f.input,
        nativeJobs: f.createJobs(),
        nativeLifecycle: lifecycle,
        preserveSessionsOnShutdown: true,
      })
      cleanups.push(() => manager.shutdown())
      lifecycle.connect(manager)
      const abort = new AbortController()
      const restoring = lifecycle.start(abort.signal)
      try {
        await listed.promise
        expect(f.ready).toEqual([])
        // when the agent appears, the deadline expires, or unload wins
        available = outcome !== "timeout" && outcome !== "dispose"
        if (outcome === "dispose") {
          abort.abort()
          await lifecycle.dispose()
        }
        release.resolve()
        await restoring
        // then readiness controls whether the recovered execution is acknowledged
        expect(f.ready).toEqual(outcome === "dispose" ? [] : ["1"])
      } finally {
        release.resolve()
        clock.mockRestore()
        await lifecycle.dispose()
      }
    },
  )
})

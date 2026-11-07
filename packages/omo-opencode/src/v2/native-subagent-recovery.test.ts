import { afterEach, describe, expect, it } from "bun:test"
import { BackgroundManager } from "../features/background-agent/manager"
import { V2NativeSubagentJobs } from "./native-subagent-jobs"
import { backgroundTaskRecord } from "./background-task-record"
import { cleanupNativeFixtures, cleanups, fixture } from "./native-subagent-jobs-test-fixture"
import { createNativeRecoveryNotifier } from "./native-recovery-notice"

afterEach(cleanupNativeFixtures)

describe("native recovery failure boundaries", () => {
  it.each(["stopped", "shutdown"] as const)(
    "#given %s during recovery #when restore returns #then it does not process queued jobs",
    async (reason) => {
      // given
      const f = await fixture()
      const jobs = f.createJobs()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let blockSave = false
      const manager = new BackgroundManager({
        pluginContext: f.input,
        nativeJobs: jobs,
        preserveSessionsOnShutdown: true,
        nativeLifecycle: {
          save: async () => {
            if (blockSave) {
              entered.resolve()
              await release.promise
            }
          },
          notify: async () => {},
        },
      })
      cleanups.push(() => manager.shutdown())
      await manager.launch(f.launch("queued-before-restore"))
      let processed = 0
      Reflect.set(manager, "processKey", async () => {
        processed++
      })
      let shutdown: Promise<void> | undefined
      if (reason === "stopped") jobs.stop()
      else {
        blockSave = true
        shutdown = manager.shutdown()
        await entered.promise
      }
      // when
      try {
        await manager.restoreNativeJobs()
        // then
        expect(processed).toBe(0)
      } finally {
        release.resolve()
        await shutdown
      }
    },
  )

  it("observes existing runs and restores their permits when catalog reconciliation fails", async () => {
    const f = await fixture()
    const began = f.nextStart()
    const previous = await f.manager.launch(f.launch("persisted"))
    await began
    const persisted = backgroundTaskRecord.parse(f.stored.get(previous.id))
    await f.manager.shutdown()
    const jobs = new V2NativeSubagentJobs(
      f.context,
      {
        ...f.domain,
        reconcile: async () => {
          throw new Error("catalog unavailable")
        },
      },
      {
        activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
        restoreSkills: async () => ({ text: "" }),
        save: async () => {},
        notifyRecovery: async () => {},
      },
    )
    const manager = new BackgroundManager({
      pluginContext: f.input,
      config: { defaultConcurrency: 1 },
      nativeJobs: jobs,
      nativeLifecycle: { save: async () => {}, notify: async () => {} },
      preserveSessionsOnShutdown: true,
    })
    cleanups.push(() => manager.shutdown())
    manager.adoptRetainedTask(persisted)
    await manager.restoreNativeJobs().catch(() => {})
    expect(f.ready).toEqual(["1"])
    const next = await manager.launch(f.launch("next"))
    expect(next.status).toBe("pending")
    const finished = manager.waitForNativeTask(previous.id, new AbortController().signal)
    const beganNext = f.nextStart()
    f.finish(previous.nativeAdmissionID ?? "")
    expect((await finished).status).toBe("completed")
    await beganNext
    expect(f.starts).toEqual([previous.sessionId, "child-2"])
  })

  it("opens admission after whole reconciliation fails", async () => {
    // given a native host whose reconciliation fails before any task is visited
    const f = await fixture()
    const jobs = new V2NativeSubagentJobs(
      f.context,
      {
        ...f.domain,
        reconcile: async () => {
          throw new Error("reconcile unavailable")
        },
      },
      {
        activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
        restoreSkills: async () => ({ text: "" }),
        save: async () => {},
        notifyRecovery: async () => {},
      },
    )
    const manager = new BackgroundManager({
      pluginContext: f.input,
      nativeJobs: jobs,
      preserveSessionsOnShutdown: true,
    })
    cleanups.push(() => manager.shutdown())
    // when startup fails
    await manager.restoreNativeJobs().catch(() => {})
    const started = f.nextStart()
    const task = await manager.launch(f.launch("after-failure"))
    await started
    // then a new synchronous wait reaches a terminal result instead of waiting on startup forever
    const result = manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "")
    expect((await result).status).toBe("completed")
  })

  it("does not acknowledge a recovered run after stop interrupts skill replay", async () => {
    // given restoration suspended at the skill boundary
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch(f.launch("replay"))
    await started
    const replay = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const jobs = new V2NativeSubagentJobs(f.context, f.domain, {
      activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
      save: async () => {},
      notifyRecovery: async () => {},
      restoreSkills: async () => {
        replay.resolve()
        await release.promise
        return { text: "" }
      },
    })
    const restoring = jobs.restore([task], async () => {})
    await replay.promise
    // when unload stops recovery before replay returns
    jobs.stop()
    release.resolve()
    await restoring
    // then no execution is acknowledged after stop
    expect(f.ready).toEqual([])
  })

  it("continues peers when an unrecoverable prepared task cannot be persisted", async () => {
    // given a missing admission without a run and a healthy running peer
    const f = await fixture()
    const started = f.nextStart()
    const peer = await f.manager.launch(f.launch("peer"))
    await started
    const poison = {
      ...backgroundTaskRecord.parse(f.stored.get(peer.id)),
      id: "bg_missing",
      nativeAdmissionID: "missing",
      nativeRun: undefined,
    }
    const jobs = new V2NativeSubagentJobs(f.context, f.domain, {
      activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
      restoreSkills: async () => ({ text: "" }),
      save: async (task) => {
        if (task.id === poison.id) throw new Error("disk unavailable")
      },
      notifyRecovery: async () => {},
    })
    // when the terminal failure receipt cannot be saved
    await jobs.restore([poison, peer], async () => {})
    // then the poison stays terminal in memory and its peer is still resumed
    expect(poison.status).toBe("error")
    expect(f.ready).toEqual(["1"])
  })

  it("delivers one parent failure notice through the prompt gate after admission cancellation", async () => {
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch(f.launch("notice"))
    await started
    const jobs = new V2NativeSubagentJobs(
      f.context,
      {
        ...f.domain,
        ready: async () => {
          throw new Error("denied recovery")
        },
      },
      {
        activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
        restoreSkills: async () => ({ text: "" }),
        save: async () => {},
        notifyRecovery: createNativeRecoveryNotifier(f.context, f.input, () => true),
      },
    )
    await jobs.restore([task], async () => {})
    await jobs.restore([task], async () => {})
    expect(f.rows.get(task.nativeAdmissionID ?? "")?.status).toBe("cancelled")
    expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toMatchObject([
      {
        kind: "synthetic",
        input: { sessionID: "parent", text: expect.stringContaining("denied recovery"), resume: true },
      },
    ])
  })
})

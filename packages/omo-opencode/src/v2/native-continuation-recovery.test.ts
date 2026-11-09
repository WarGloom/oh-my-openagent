import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { BackgroundManager } from "../features/background-agent/manager"
import {
  archiveBackgroundTask,
  clearBackgroundTaskRegistryForTesting,
} from "../features/background-agent/task-registry"
import { backgroundTaskRecord, encodeBackgroundTask } from "./background-task-record"
import { cleanupNativeFixtures, cleanups, completedFixture } from "./native-subagent-jobs-test-fixture"
import { V2BackgroundLifecycle } from "./background-lifecycle"

afterEach(cleanupNativeFixtures)

describe("native task entrypoint retained continuation", () => {
  it.each(["archive", "durable", "restart", "reload-variant", "reload-switch", "reload-chain"] as const)(
    "continues the original child after cleanup from %s",
    async (source) => {
      // given a completed child removed through the manager's cleanup timer
      const f = await completedFixture()
      let manager = f.manager
      if (source === "archive") {
        await f.context.storage?.remove(
          `background-task/${encodeURIComponent(f.context.location.directory)}/${f.task.id}`,
        )
      }
      if (source === "restart") {
        await manager.shutdown()
        clearBackgroundTaskRegistryForTesting()
        manager = new BackgroundManager({
          pluginContext: f.input,
          nativeJobs: f.createJobs(),
          preserveSessionsOnShutdown: true,
        })
        cleanups.push(() => manager.shutdown())
        await manager.restoreNativeJobs()
      }
      if (source === "reload-variant" || source === "reload-switch" || source === "reload-chain") {
        const storage = f.context.storage
        const get = f.session.getMockImplementation()
        if (!storage || !get) throw new Error("native fixture missing")
        await manager.shutdown()
        const model =
          source === "reload-variant"
            ? { providerID: "test", id: "model", variant: "max" }
            : { providerID: "switched", id: "model2", variant: "high" }
        const previous = { providerID: "test", id: "model", variant: "max" }
        const intermediate = { providerID: "test", id: "intermediate", variant: "medium" }
        const created = f.retained.startedAt?.getTime() ?? 0
        if (source === "reload-chain")
          f.fake
            .sessionHistory(f.sessionID)
            .push({ id: "msg_first_switch", type: "model-switched", previous, model: intermediate, time: { created } })
        if (source !== "reload-variant")
          f.fake.sessionHistory(f.sessionID).push({
            id: "msg_switch",
            type: "model-switched",
            previous: source === "reload-chain" ? intermediate : previous,
            model,
            time: { created: created + 1 },
          })
        f.session.mockImplementation(async (input) => {
          const child = await get(input)
          return { ...child, ...(input.sessionID === f.sessionID ? { model } : {}) }
        })
        await storage.set(
          `background-task/${encodeURIComponent(f.context.location.directory)}/${f.task.id}`,
          encodeBackgroundTask({
            ...f.retained,
            model: { ...f.retained.model, providerID: "test", modelID: "model", reasoning: "max" },
          }),
        )
        const lifecycle = new V2BackgroundLifecycle(f.context, storage)
        await lifecycle.load()
        manager = new BackgroundManager({
          pluginContext: f.input,
          config: { taskCleanupDelayMs: 0 },
          nativeJobs: f.createJobs(),
          nativeLifecycle: lifecycle,
          preserveSessionsOnShutdown: true,
        })
        const reloaded = manager
        cleanups.push(() => reloaded.shutdown())
        const removed = Promise.withResolvers<void>()
        cleanups.push(
          reloaded.onVisibleChange(() => {
            if (!reloaded.findBySession(f.sessionID)) removed.resolve()
          }),
        )
        lifecycle.connect(reloaded)
        await reloaded.restoreNativeJobs()
        await removed.promise
      }
      // when the real task tool continues that retained session
      const started = f.nextStart()
      await f.execute(manager)
      await started
      const settled = manager.waitForNativeTask(f.task.id, new AbortController().signal)
      f.finish([...f.rows.values()].at(-1)?.admissionID ?? "")
      const continued = await settled
      // then the same task owns one new native admission to the same child
      expect(continued).toMatchObject({
        id: f.task.id,
        sessionId: f.task.sessionId,
        model:
          source === "reload-switch" || source === "reload-chain"
            ? { providerID: "switched", modelID: "model2", variant: "high" }
            : f.retained.model,
        decisionId: f.retained.decisionId,
        category: "retained",
        skills: ["skill"],
        nativeRun: { childSessionID: f.task.sessionId, generation: "2" },
        nativeSkillActivationIDs: ["activation-1"],
      })
      expect(continued?.attempts?.map((attempt) => attempt.cause)).toEqual(["initial", "continuation"])
      expect(continued?.attempts?.[0]).toEqual(f.retained.attempts?.[0])
      expect(f.starts).toEqual([f.sessionID, f.sessionID])
      expect([...f.rows.values()].map((row) => row.childSessionID)).toEqual([f.sessionID, f.sessionID])
      expect(f.rows.get(f.retained.nativeAdmissionID ?? "")?.run).toEqual(f.retained.nativeRun)
      expect(continued.status).toBe("completed")
    },
  )

  it.each([
    "missing",
    "missing-child",
    "foreign",
    "cancelled",
    "cancelled-admission",
    "revoked",
    "generation",
    "model",
    "variant",
    "busy",
    "storage",
    "newer",
    "switch-missing",
    "switch-previous",
    "switch-broken",
    "switch-unrelated",
    "switch-stale",
    "switch-archive",
  ] as const)("rejects %s retained state before another native admission", async (failure) => {
    // given retained metadata or current native state that cannot authorize recovery
    const f = await completedFixture()
    const receipt = f.rows.get(f.retained.nativeAdmissionID ?? "")
    if (!receipt || !f.context.storage) throw new Error("native fixture missing")
    const key = `background-task/${encodeURIComponent(f.context.location.directory)}/${f.task.id}`
    const child = await f.context.session.get({ sessionID: receipt.childSessionID })
    switch (failure) {
      case "missing":
        clearBackgroundTaskRegistryForTesting()
        await f.context.storage.remove(key)
        break
      case "foreign":
        f.session.mockImplementation(async (input) => ({ ...child, id: input.sessionID, parentID: "other-parent" }))
        break
      case "missing-child":
        f.session.mockImplementation(async () => {
          throw new Error("child missing")
        })
        break
      case "cancelled":
        await f.context.storage.set(key, encodeBackgroundTask({ ...f.retained, status: "cancelled" }))
        break
      case "revoked":
        f.rows.set(receipt.admissionID, { ...receipt, revoked: true })
        break
      case "cancelled-admission":
        f.rows.set(receipt.admissionID, { ...receipt, status: "cancelled" })
        break
      case "generation":
        f.rows.set(receipt.admissionID, {
          ...receipt,
          run: { childSessionID: receipt.childSessionID, generation: "newer" },
        })
        break
      case "model":
        f.session.mockImplementation(async (input) => ({
          ...child,
          id: input.sessionID,
          model: { providerID: "test", id: "different" },
        }))
        break
      case "variant":
        clearBackgroundTaskRegistryForTesting()
        await f.context.storage.set(
          key,
          encodeBackgroundTask({ ...f.retained, model: { providerID: "test", modelID: "model", reasoning: "max" } }),
        )
        f.session.mockImplementation(async (input) => ({
          ...child,
          id: input.sessionID,
          model: { providerID: "test", id: "model", variant: "high" },
        }))
        break
      case "busy":
        f.session.mockImplementation(async (input) => ({
          ...child,
          id: input.sessionID,
          time: { created: 1, updated: 3, busy: 3, idle: 2 },
        }))
        break
      case "storage":
        await f.context.storage.set(key, encodeBackgroundTask({ ...f.retained, id: "different-task" }))
        break
      case "newer":
        await f.domain.prepare({
          admissionID: "newer",
          parentSessionID: "parent",
          agent: "worker",
          model: { providerID: "test", id: "model" },
          maxDepth: 1,
          description: "newer",
          invocation: { kind: "tool", agent: "parent-agent", messageID: "newer", toolCallID: "newer" },
          target: { kind: "existing", sessionID: receipt.childSessionID },
        })
        await f.domain.start({
          admissionID: "newer",
          prompt: { text: "newer" },
          delivery: "steer",
          mode: "background",
          completion: "parent",
        })
        break
      case "switch-missing":
      case "switch-previous":
      case "switch-broken":
      case "switch-unrelated":
      case "switch-stale":
      case "switch-archive": {
        const model = { providerID: "switched", id: "model2", variant: "high" }
        const previous = { providerID: "test", id: "model" }
        const unrelated = { providerID: "other", id: "unrelated" }
        const created = f.retained.startedAt?.getTime() ?? 0
        f.session.mockImplementation(async (input) => ({ ...child, id: input.sessionID, model }))
        if (failure === "switch-archive")
          archiveBackgroundTask({ ...f.retained, model: { providerID: "other", modelID: "unrelated" } })
        if (failure === "switch-broken")
          f.fake.sessionHistory(f.sessionID).push({
            id: "msg_first_switch",
            type: "model-switched",
            previous,
            model: { providerID: "test", id: "intermediate" },
            time: { created },
          })
        if (failure !== "switch-missing")
          f.fake.sessionHistory(f.sessionID).push({
            id: "msg_switch",
            type: "model-switched",
            previous:
              failure === "switch-previous"
                ? undefined
                : failure === "switch-broken" || failure === "switch-unrelated"
                  ? unrelated
                  : previous,
            model,
            time: { created: failure === "switch-stale" ? created - 1 : created + 1 },
          })
        break
      }
      default:
        throw new Error(`Unexpected failure: ${failure satisfies never}`)
    }
    const admissions = f.rows.size
    const starts = [...f.starts]
    // when the parent requests continuation through the task entrypoint
    await expect(f.execute(f.manager)).rejects.toThrow(
      failure === "missing" ? "Task not found" : failure === "missing-child" ? "child missing" : /recovery denied/,
    )
    // then it cannot adopt a task or create another admission
    expect(f.manager.findBySession(receipt.childSessionID)).toBeUndefined()
    expect(f.rows.size).toBe(admissions)
    expect(f.starts).toEqual(starts)
  })

  it("rejects another continuation after recovery adoption queues behind an occupied permit", async () => {
    // given a retained child and another task occupying the only native permit
    const f = await completedFixture()
    const blockerStarted = f.nextStart()
    const blocker = await f.manager.launch(f.launch("blocker"))
    await blockerStarted
    await f.execute(f.manager)
    const queued = f.manager.findBySession(f.sessionID)
    if (!queued) throw new Error("recovered task missing")
    const admissionID = queued.nativeAdmissionID
    const attemptID = queued.currentAttemptID
    expect(queued.status).toBe("pending")
    expect(f.rows.get(admissionID ?? "")?.status).toBe("prepared")
    // when a separate tool invocation targets the already queued child
    await expect(f.execute(f.manager, "competitor")).rejects.toThrow(/continuation queued/)
    // then one admission retains the original task and its queued attempt
    expect(f.rows.size).toBe(3)
    expect(queued).toMatchObject({
      id: f.task.id,
      sessionId: f.sessionID,
      nativeAdmissionID: admissionID,
      currentAttemptID: attemptID,
    })
    expect(queued.attempts).toHaveLength(2)
    const resumed = f.nextStart()
    f.finish(blocker.nativeAdmissionID ?? "")
    await resumed
    const settled = f.manager.waitForNativeTask(f.task.id, new AbortController().signal)
    f.finish(admissionID ?? "")
    expect(await settled).toMatchObject({
      id: f.task.id,
      sessionId: f.sessionID,
      status: "completed",
      currentAttemptID: attemptID,
    })
    expect(f.starts).toEqual([f.sessionID, blocker.sessionId ?? "", f.sessionID])
  })

  it("cancels prepared recovery when the lifecycle save fails and permits retry on the same child", async () => {
    // given a save failure only after native preparation has persisted its admission
    const f = await completedFixture()
    const storage = f.context.storage
    if (!storage) throw new Error("fake storage missing")
    const set = storage.set
    let pendingSaves = 0
    let failedAdmissionID = ""
    const failure = new Error("injected continuation lifecycle save failure")
    const saving = spyOn(storage, "set").mockImplementation(async (key, value) => {
      const parsed = backgroundTaskRecord.safeParse(value)
      if (parsed.success && parsed.data.id === f.task.id && parsed.data.status === "pending") {
        pendingSaves += 1
        if (pendingSaves === 2) {
          failedAdmissionID = parsed.data.nativeAdmissionID ?? ""
          expect(f.rows.get(failedAdmissionID)?.status).toBe("prepared")
          throw failure
        }
      }
      await set(key, value)
    })
    cleanups.push(() => saving.mockRestore())
    // when the real task tool cannot persist its prepared continuation
    await expect(f.execute(f.manager)).rejects.toThrow(failure.message)
    // then the orphan admission is cancelled and both task views retain the terminal attempt
    expect(pendingSaves).toBe(2)
    expect(f.rows.get(failedAdmissionID)?.status).toBe("cancelled")
    expect(f.manager.findBySession(f.sessionID)).toMatchObject({
      status: "completed",
      nativeAdmissionID: f.retained.nativeAdmissionID,
      currentAttemptID: f.retained.currentAttemptID,
      attempts: f.retained.attempts,
    })
    expect(
      backgroundTaskRecord.parse(
        await storage.get(`background-task/${encodeURIComponent(f.context.location.directory)}/${f.task.id}`),
      ),
    ).toMatchObject({
      status: "completed",
      nativeAdmissionID: f.retained.nativeAdmissionID,
      attempts: f.retained.attempts,
    })
    expect(f.manager.hasActiveChildTasks("parent")).toBe(false)
    expect(f.starts).toEqual([f.sessionID])
    const resumed = f.nextStart()
    await f.execute(f.manager, "retry")
    await resumed
    const settled = f.manager.waitForNativeTask(f.task.id, new AbortController().signal)
    f.finish(f.manager.findBySession(f.sessionID)?.nativeAdmissionID ?? "")
    expect(await settled).toMatchObject({ id: f.task.id, sessionId: f.sessionID, status: "completed" })
    expect(f.starts).toEqual([f.sessionID, f.sessionID])
    expect(f.rows.size).toBe(3)
  })

  it("keeps the recovery claim until adoption and admission finish", async () => {
    // given a recovery paused at durable lookup
    const f = await completedFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const scan = f.context.storage?.scan
    if (!scan || !f.context.storage) throw new Error("fake storage missing")
    const reading = spyOn(f.context.storage, "scan").mockImplementation(async (input) => {
      entered.resolve()
      await release.promise
      return scan(input)
    })
    cleanups.push(() => reading.mockRestore())
    const first = f.execute(f.manager)
    await entered.promise
    // when another invocation targets the claimed child
    await expect(f.execute(f.manager, "competitor")).rejects.toThrow("active, claimed")
    release.resolve()
    const started = f.nextStart()
    await first
    await started
    const settled = f.manager.waitForNativeTask(f.task.id, new AbortController().signal)
    f.finish([...f.rows.values()].at(-1)?.admissionID ?? "")
    await settled
    // then only the winning continuation admits work
    expect(f.starts).toEqual([f.sessionID, f.sessionID])
    expect(f.rows.size).toBe(2)
  })
})

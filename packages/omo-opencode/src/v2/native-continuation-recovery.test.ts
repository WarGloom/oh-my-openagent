import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { BackgroundManager } from "../features/background-agent/manager"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { createDelegateTask } from "../tools/delegate-task/tools"
import { backgroundTaskRecord, encodeBackgroundTask } from "./background-task-record"
import { cleanupNativeFixtures, cleanups, fixture } from "./native-subagent-jobs-test-fixture"
import * as ledger from "../tools/delegate-task/jev-routing-ledger"

afterEach(cleanupNativeFixtures)

async function completedFixture() {
  const record = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
  cleanups.push(() => record.mockRestore())
  const f = await fixture({ cleanupDelay: 0 })
  const get = f.context.session.get
  const session = spyOn(f.context.session, "get").mockImplementation(async (input) => ({
    ...(await get(input)),
    ...(input.sessionID === "parent" ? {} : { parentID: "parent", agent: "worker" }),
  }))
  cleanups.push(() => session.mockRestore())
  const started = f.nextStart()
  const task = await f.manager.launch({
    ...f.launch("initial"),
    decisionId: crypto.randomUUID(),
    category: "retained",
    skills: ["skill"],
  })
  await started
  const removed = Promise.withResolvers<void>()
  cleanups.push(
    f.manager.onVisibleChange(() => {
      if (!f.manager.findBySession(task.sessionId ?? "")) removed.resolve()
    }),
  )
  const completed = f.manager.waitForNativeTask(task.id, new AbortController().signal)
  f.finish(task.nativeAdmissionID ?? "")
  await completed
  await removed.promise
  const retained = backgroundTaskRecord.parse(f.stored.get(task.id))
  const sessionID = task.sessionId
  if (!sessionID) throw new Error("native child missing")
  const execute = (manager: BackgroundManager, callID = "continue") => {
    const context = {
      sessionID: "parent",
      messageID: "followup-message",
      agent: "parent-agent",
      callID,
      abort: new AbortController().signal,
      directory: f.input.directory,
      worktree: f.input.directory,
      ask: async () => {},
      metadata: async () => {},
    }
    return createDelegateTask({ manager, client: f.input.client, directory: f.input.directory }).execute(
      {
        task_id: sessionID,
        prompt: "followup",
        description: "continue retained",
        run_in_background: true,
        load_skills: [],
      },
      context,
    )
  }
  return { ...f, task, sessionID, retained, execute, session }
}

describe("native task entrypoint retained continuation", () => {
  it.each(["archive", "durable", "restart"] as const)(
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
        model: f.retained.model,
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
    "busy",
    "storage",
    "newer",
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

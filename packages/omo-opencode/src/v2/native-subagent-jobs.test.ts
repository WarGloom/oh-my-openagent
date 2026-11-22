import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { BackgroundManager } from "../features/background-agent/manager"
import type { NativeDelegationSkills } from "./native-subagent-jobs"
import { backgroundTaskRecord } from "./background-task-record"
import { cleanupNativeFixtures, cleanups, fixture } from "./native-subagent-jobs-test-fixture"
import { V2NativeSubagentJobs } from "./native-subagent-jobs"
import { createDelegateTask } from "../tools/delegate-task/tools"
import { subscribeTaskLifecycle, type TaskLifecycleEvent } from "../features/background-agent/task-lifecycle"
import * as ledger from "../tools/delegate-task/jev-routing-ledger"
import "../tools/delegate-task/jev-routing-context"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let recordSpy: ReturnType<typeof spyOn>
beforeEach(() => {
  recordSpy = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
})
afterEach(async () => {
  await cleanupNativeFixtures()
  recordSpy.mockRestore()
})

describe("native subagent consumer", () => {
  it("passes task completion_group to the same native admission as other job options", async () => {
    const f = await fixture({ requireSystem: false })
    const start = spyOn(f.domain, "start")
    const started = f.nextStart()
    const client = {
      ...f.input.client,
      app: {
        ...f.input.client.app,
        agents: async () =>
          unsafeTestValue({
            data: [{ name: "worker", mode: "subagent", model: { providerID: "test", modelID: "model" } }],
          }),
      },
    }
    const tool = createDelegateTask({ manager: f.manager, client, directory: f.input.directory })
    const context = {
      sessionID: "parent",
      messageID: "message",
      agent: "parent-agent",
      callID: "grouped-task",
      abort: new AbortController().signal,
      directory: f.input.directory,
      worktree: f.input.directory,
      ask: async () => {},
      metadata: async () => {},
    }
    const args = { subagent_type: "worker", prompt: "Review the fixture", load_skills: [], completion_group: "review" }
    const invalid = await tool.execute({ ...args, run_in_background: false }, context)
    expect(invalid).toContain("requires run_in_background: true")
    expect(start).not.toHaveBeenCalled()
    const answer = await tool.execute({ ...args, run_in_background: true }, context)
    expect(answer).toContain("Background Task ID:")
    await started
    expect(start.mock.calls[0]?.[0]).toMatchObject({ completion: "parent", completionGroup: "review" })
  })

  it("records the observed model per generation and leaves a continuation without evidence unknown", async () => {
    const f = await fixture()
    const decisionId = crypto.randomUUID()
    const directory = mkdtempSync(join(tmpdir(), "jev-native-outcomes-"))
    const originalDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = directory
    cleanups.push(() => {
      if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = originalDataHome
      rmSync(directory, { recursive: true, force: true })
    })
    const writes: Promise<void>[] = []
    const outcomes: Extract<ledger.JevRoutingRecord, { event: "outcome" }>[] = []
    const firstPublished = Promise.withResolvers<void>()
    const published = Promise.withResolvers<void>()
    recordSpy.mockImplementation((record) => {
      const write = ledger.appendJevRoutingRecord(record).then(() => {
        if (record.event !== "outcome" || record.decision_id !== decisionId) return
        outcomes.push(record)
        if (outcomes.length === 1) firstPublished.resolve()
        if (outcomes.length === 2) published.resolve()
      })
      writes.push(write)
      return write
    })
    const started = f.nextStart()
    const task = await f.manager.launch({ ...f.launch("first"), decisionId })
    await started
    const first = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "", "completed", { providerID: "observed", id: "actual" })
    await first
    await firstPublished.promise
    const resumed = f.nextStart()
    await f.manager.resume({
      sessionId: task.sessionId ?? "",
      prompt: "followup",
      parentSessionId: "parent",
      parentMessageId: "message",
      nativeInvocation: { kind: "tool", agent: "parent-agent", messageID: "message", toolCallID: "followup" },
    })
    await resumed
    const second = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(f.manager.getTask(task.id)?.nativeAdmissionID ?? "")
    await second
    await published.promise
    await Promise.all(writes)
    expect(outcomes).toHaveLength(2)
    const ledgerPath = join(
      ledger.getJevLedgerDirectory(),
      readdirSync(ledger.getJevLedgerDirectory()).find((name) => name.endsWith(".jsonl")) ?? "",
    )
    const rows = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(
      rows.filter((row) => row.event === "outcome" && row.decision_id === decisionId).map((row) => row.producing_model),
    ).toEqual(["observed/actual", null])
    expect(outcomes[0]?.attempt_id).not.toBe(outcomes[1]?.attempt_id)
  })

  it.each(["ready", "skills", "missing"] as const)(
    "isolates a recovered %s failure and releases its permit while restoring peers",
    async (failure) => {
      // given two persisted native runs, one of which cannot be restored
      const f = await fixture()
      const started = f.nextStart()
      const first = await f.manager.launch(f.launch("poison"))
      await started
      const peerStarted = f.nextStart()
      const peer = await f.manager.launch({ ...f.launch("peer"), nativeInheritedPermit: true })
      await peerStarted
      const stored = [first, peer].map((task) => backgroundTaskRecord.parse(f.stored.get(task.id)))
      await f.manager.shutdown()
      const jobs = new V2NativeSubagentJobs(
        f.context,
        {
          ...f.domain,
          reconcile: async () =>
            failure === "missing"
              ? [...f.rows.values()].filter((row) => row.admissionID !== first.nativeAdmissionID)
              : [...f.rows.values()],
          get: async (target) =>
            failure === "missing" && "admissionID" in target && target.admissionID === first.nativeAdmissionID
              ? undefined
              : f.domain.get(target),
          ready: async (input) => {
            if (failure === "ready" && input.run.childSessionID === first.sessionId)
              throw new Error("Permission denied: skill")
            return f.domain.ready(input)
          },
        },
        {
          activateSkills: async () => ({ text: "", activationIDs: [], selections: [] }),
          restoreSkills: async (task) => {
            if (failure === "skills" && task.id === first.id) throw new Error("Accepted skill activation unavailable")
            return { text: "accepted skill content" }
          },
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
      for (const task of stored) manager.adoptRetainedTask(task)
      // when recovery encounters the poison run
      await manager.restoreNativeJobs()
      const failed = await manager.waitForNativeTask(first.id, new AbortController().signal)
      // then it ends only that task and restores the healthy peer
      expect(failed.status).toBe("error")
      expect(failed.error).toMatch(/Permission denied|activation unavailable|admission missing/)
      expect(f.ready).toEqual(["2"])
      const nextStarted = f.nextStart()
      await manager.launch(f.launch("next"))
      await nextStarted
      expect(f.starts).toEqual([first.sessionId, peer.sessionId, "child-3"])
    },
  )

  it.each([false, true])("preserves native permit lifetime with inherited nested permit=%s", async (inherited) => {
    const f = await fixture()
    const firstStarted = f.nextStart()
    const first = await f.manager.launch(f.launch("first"))
    await firstStarted
    const secondStarted = f.nextStart()
    const second = await f.manager.launch({ ...f.launch("second"), nativeInheritedPermit: inherited })
    if (inherited) await secondStarted
    expect(second.status).toBe("pending")
    expect(f.starts).toEqual(inherited ? [first.sessionId, second.sessionId] : [first.sessionId])
    const completed = f.manager.waitForNativeTask(first.id, new AbortController().signal)
    f.finish(first.nativeAdmissionID ?? "")
    await secondStarted
    await completed
    expect(f.starts).toEqual([first.sessionId, second.sessionId])
    expect(f.manager.getTask(first.id)?.status).toBe("completed")
    expect(f.notices).toEqual([])
    expect(
      f.fake.sessionCalls.filter(
        (call) => call.kind === "create" || call.kind === "prompt" || call.kind === "synthetic",
      ),
    ).toEqual([])
  })

  it("keeps permission denial final before a child or queued execution is created", async () => {
    const f = await fixture({ denied: true })
    await expect(f.manager.launch(f.launch("denied"))).rejects.toThrow("permission denied")
    expect(f.rows.size).toBe(0)
    expect(f.starts).toEqual([])
    expect(f.manager.getTasksByParentSession("parent")).toEqual([])
  })

  it("coalesces retries of one authentic tool invocation into one queued task", async () => {
    const f = await fixture()
    const started = f.nextStart()
    const tasks = await Promise.all([f.manager.launch(f.launch("same")), f.manager.launch(f.launch("same"))])
    await started
    expect(tasks[0]?.id).toBe(tasks[1]?.id)
    expect(f.rows.size).toBe(1)
    expect(f.starts).toEqual(["child-1"])
  })

  it.each(["pending", "running"] as const)(
    "cancels %s native work when its synchronous waiter is interrupted",
    async (status) => {
      const f = await fixture()
      const started = f.nextStart()
      const first = await f.manager.launch(f.launch("first"))
      await started
      const pending = await f.manager.launch(f.launch("pending"))
      const task = status === "pending" ? pending : first
      const resumed = status === "running" ? f.nextStart() : undefined
      const controller = new AbortController()
      const waiter = f.manager.waitForNativeTask(task.id, controller.signal)
      controller.abort(new Error("interrupted"))
      await expect(waiter).rejects.toThrow("interrupted")
      if (resumed) await resumed
      expect(f.rows.get(task.nativeAdmissionID ?? "")?.status).toBe("cancelled")
      expect(f.starts).toEqual(status === "pending" ? [first.sessionId] : [first.sessionId, pending.sessionId])
      // then: the parent learns which child session to continue, without being resumed
      const notes = f.fake.sessionCalls.flatMap((call) => (call.kind === "synthetic" ? [call.input] : []))
      expect(
        notes.map((note) => ({
          sessionID: note.sessionID,
          resume: note.resume,
          namesContinuation: note.text.includes(`task_id="${task.sessionId}"`),
        })),
      ).toEqual(status === "running" ? [{ sessionID: "parent", resume: false, namesContinuation: true }] : [])
    },
  )

  it("exposes native failure to a synchronous waiter without an OMO retry or completion wake", async () => {
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch({ ...f.launch("sync"), nativeMode: "foreground", nativeCompletion: "none" })
    await started
    const result = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "", "error")
    expect(await result).toMatchObject({ status: "error", error: "failed", result: "child result" })
    expect(f.starts).toHaveLength(1)
    expect(backgroundTaskRecord.parse(f.stored.get(task.id))).toMatchObject({
      nativeCompletion: "none",
      nativeRun: { childSessionID: "child-1", generation: "1" },
    })
  })

  it("resumes the same child with a fresh native generation and stable OMO task identity", async () => {
    const f = await fixture()
    const decisionId = crypto.randomUUID()
    const events: TaskLifecycleEvent[] = []
    const observed = Promise.withResolvers<void>()
    cleanups.push(
      subscribeTaskLifecycle((event) => {
        if (event.decisionId === decisionId) events.push(event)
        if (events.filter((event) => event.event === "outcome").length === 2) observed.resolve()
      }),
    )
    const started = f.nextStart()
    const task = await f.manager.launch({ ...f.launch("first"), decisionId })
    await started
    const completed = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "")
    await completed
    const resumed = f.nextStart()
    await f.manager.resume({
      sessionId: task.sessionId ?? "",
      prompt: "followup",
      parentSessionId: "parent",
      parentMessageId: "message",
      nativeInvocation: { kind: "tool", agent: "parent-agent", messageID: "message", toolCallID: "followup" },
    })
    await resumed
    expect(f.manager.getTask(task.id)?.nativeContinued).toBe(true)
    expect(backgroundTaskRecord.parse(f.stored.get(task.id)).nativeContinued).toBe(true)
    const result = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(f.manager.getTask(task.id)?.nativeAdmissionID ?? "")
    await result
    await observed.promise
    expect(f.starts).toEqual(["child-1", "child-1"])
    expect(f.manager.getTask(task.id)?.nativeRun).toEqual({ childSessionID: "child-1", generation: "2" })
    expect(f.manager.getTask(task.id)?.attempts).toHaveLength(2)
    expect(backgroundTaskRecord.parse(f.stored.get(task.id)).decisionId).toBe(decisionId)
    const outcomes = events.filter((event) => event.event === "outcome")
    expect(outcomes).toHaveLength(2)
    expect(outcomes.map((event) => event.taskId)).toEqual([task.id, task.id])
    expect(outcomes[0]?.attemptId).not.toBe(outcomes[1]?.attemptId)
    expect(
      events.filter((event) => event.event === "attempt" && event.childSessionId !== null).map((event) => event.cause),
    ).toEqual(["initial", "continuation"])
  })

  it("native completion settles before terminal evidence returns", async () => {
    const f = await fixture()
    const decisionId = crypto.randomUUID()
    const response = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<void>()
    const manager = new BackgroundManager({
      pluginContext: unsafeTestValue({
        ...f.input,
        client: {
          ...f.input.client,
          session: {
            ...f.input.client.session,
            messages: async () => {
              entered.resolve()
              return response.promise
            },
          },
        },
      }),
      config: { defaultConcurrency: 1 },
      nativeJobs: f.createJobs(),
      nativeLifecycle: { save: async () => {}, notify: async () => {} },
      preserveSessionsOnShutdown: true,
    })
    cleanups.push(() => manager.shutdown())
    await manager.restoreNativeJobs()
    const started = f.nextStart()
    const task = await manager.launch({ ...f.launch("nonblocking-terminal"), decisionId })
    await started
    const outcome = Promise.withResolvers<TaskLifecycleEvent>()
    cleanups.push(
      subscribeTaskLifecycle((event) => {
        if (event.decisionId === decisionId && event.event === "outcome") outcome.resolve(event)
      }),
    )
    const settled = manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "")
    expect(await settled).toMatchObject({ status: "completed", result: "child result" })
    await entered.promise
    response.resolve({
      data: [
        {
          info: { role: "assistant", providerID: "test", modelID: "producing" },
          parts: [{ type: "text", text: "child result" }],
        },
      ],
    })
    expect(await outcome.promise).toMatchObject({
      decisionId,
      taskId: task.id,
      event: "outcome",
      producingModel: "test/producing",
    })
  })

  it.each(["running", "completed"] as const)(
    "restores permits before acknowledging recovered %s generation",
    async (status) => {
      const f = await fixture()
      const decisionId = crypto.randomUUID()
      const outcomes: TaskLifecycleEvent[] = []
      cleanups.push(
        subscribeTaskLifecycle((event) => {
          if (event.decisionId === decisionId && event.event === "outcome") outcomes.push(event)
        }),
      )
      const started = f.nextStart()
      const nativePrompt = {
        text: "command",
        files: [
          {
            uri: "file:///input",
            source: { type: "uri" as const, uri: "file:///original" },
            description: "attachment",
            mention: { start: 0, end: 4, text: "file" },
          },
        ],
        agents: [{ name: "worker" }],
        skills: [{ id: "skill", mention: { start: 5, end: 10, text: "skill" } }],
      }
      const task = await f.manager.launch({
        ...f.launch("first"),
        decisionId,
        nativePrompt,
        nativeMetadata: { omoCommandParts: [{ type: "text", text: "marker", synthetic: true }] },
      })
      await started
      const stored = backgroundTaskRecord.parse(f.stored.get(task.id))
      expect(stored.nativePrompt).toEqual(nativePrompt)
      expect(stored.nativeMetadata).toEqual({ omoCommandParts: [{ type: "text", text: "marker", synthetic: true }] })
      await f.manager.shutdown()
      if (status === "completed") f.finish(task.nativeAdmissionID ?? "")
      const manager = new BackgroundManager({
        pluginContext: f.input,
        config: { defaultConcurrency: 1 },
        nativeJobs: f.createJobs(),
        nativeLifecycle: {
          save: async () => {},
          notify: async () => {
            throw new Error("duplicate wake")
          },
        },
        preserveSessionsOnShutdown: true,
      })
      cleanups.push(() => manager.shutdown())
      manager.adoptRetainedTask(stored)
      await manager.restoreNativeJobs()
      const secondStarted = status === "completed" ? f.nextStart() : undefined
      const queued = await manager.launch(f.launch("second"))
      expect(f.ready).toEqual(["1"])
      expect(f.instructions.get("child-1")).toContain("system")
      expect(f.instructions.get("child-1")).not.toContain("accepted skill content")
      if (secondStarted) {
        await secondStarted
        expect(f.starts).toEqual(["child-1", "child-2"])
        expect(outcomes).toHaveLength(0)
        return
      }
      expect(queued.status).toBe("pending")
      expect(f.starts).toEqual(["child-1"])
      const next = f.nextStart()
      f.finish(task.nativeAdmissionID ?? "")
      await next
      expect(f.starts).toEqual(["child-1", "child-2"])
      expect(outcomes).toHaveLength(0)
    },
  )

  it("accepts native skills and persists exact activation IDs before starting model work", async () => {
    const accepting = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<NativeDelegationSkills>()
    let authorizations = 0
    const skillBody = `accepted-body-${crypto.randomUUID()}`
    const delegationSystem = `delegation-system-${crypto.randomUUID()}`
    const f = await fixture({
      restoredText: skillBody,
      activate: () => {
        authorizations++
        accepting.resolve()
        return accepted.promise
      },
    })
    const task = await f.manager.launch({ ...f.launch("skills"), skillContent: delegationSystem })
    await accepting.promise
    expect(f.starts).toEqual([])
    const started = f.nextStart()
    const selections = [
      { id: "canonical", arguments: "a", mention: { start: 0, end: 1, text: "a" } },
      { id: "canonical", arguments: "b", mention: { start: 2, end: 3, text: "b" } },
    ]
    accepted.resolve({ text: skillBody, activationIDs: ["arguments-a", "arguments-b"], selections })
    await started
    expect(backgroundTaskRecord.parse(f.stored.get(task.id)).nativeSkillActivationIDs).toEqual([
      "arguments-a",
      "arguments-b",
    ])
    expect(f.prompts.at(-1)?.skills).toEqual(selections)
    // native prompt placement is the only owner of accepted skill content; delegation system text stays
    expect(f.instructions.get(task.sessionId ?? "")).toContain(delegationSystem)
    expect(f.instructions.get(task.sessionId ?? "")).not.toContain(skillBody)
    const waiting = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(task.nativeAdmissionID ?? "")
    const completed = await waiting
    await f
      .createJobs()
      .start(completed, { agent: completed.agent, tools: {}, parts: [{ type: "text", text: completed.prompt }] })
    expect(authorizations).toBe(1)
    expect(f.starts).toEqual(["child-1"])
  })

  it("admits a task continuation to the running child and retains its completion", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const waitNative = f.domain.wait
    const wait = spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observing.resolve()
      return waitNative(input)
    })
    const task = await f.manager.launch({
      ...f.launch("initial"),
      nativePrompt: { text: "initial native prompt" },
      nativeCompletion: "parent",
    })
    await observing.promise
    const originalRun = f.rows.get(task.nativeAdmissionID ?? "")?.run
    const originalAdmission = task.nativeAdmissionID
    const originalRecord = backgroundTaskRecord.parse(f.stored.get(task.id))
    const put = spyOn(f.context.session.instructions.entry, "put")
    const update = spyOn(f.context.session, "update")
    const steer = spyOn(f.domain, "steer")
    const completion = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    const result = await createDelegateTask({
      manager: f.manager,
      client: f.input.client,
      directory: f.input.directory,
    }).execute(
      {
        task_id: task.sessionId ?? "",
        prompt: "clarification",
        description: "continue",
        run_in_background: true,
        load_skills: [],
      },
      {
        sessionID: "parent",
        messageID: "followup-message",
        agent: "parent-agent",
        callID: "followup",
        abort: new AbortController().signal,
        directory: f.input.directory,
        worktree: f.input.directory,
        ask: async () => {},
        metadata: async () => {},
      },
    )
    expect(result).toContain(task.id)
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[1]?.text).toContain("clarification")
    expect(f.prompts[1]?.text).not.toContain("initial native prompt")
    const continued = f.manager.getTask(task.id)
    expect(continued?.nativeRun).toEqual(originalRun)
    expect(continued?.nativeAdmissionID).toBe(originalAdmission)
    expect(f.rows.get(continued?.nativeAdmissionID ?? "")?.completion).toBe("parent")
    expect(f.starts).toEqual([task.sessionId])
    expect(wait).toHaveBeenCalledTimes(1)
    expect(f.rows.size).toBe(1)
    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer.mock.calls[0]?.[0]).toMatchObject({
      admissionID: originalAdmission,
      run: originalRun,
      invocation: { kind: "tool", messageID: "followup-message", toolCallID: "followup" },
    })
    expect(backgroundTaskRecord.parse(f.stored.get(task.id))).toEqual(originalRecord)
    expect(put).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    const pending = await f.manager.launch(f.launch("other"))
    expect(pending.status).toBe("pending")
    f.finish(continued?.nativeAdmissionID ?? "")
    expect(await completion).toMatchObject({ status: "completed", result: "child result" })
  })

  it("returns a background receipt for a foreground steer interrupted after admission", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const wait = f.domain.wait
    spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observing.resolve()
      return wait(input)
    })
    const task = await f.manager.launch({ ...f.launch("foreground-steer"), nativeCompletion: "parent" })
    await observing.promise
    const originalRun = structuredClone(f.manager.getTask(task.id)?.nativeRun)
    const originalAdmission = task.nativeAdmissionID ?? ""
    const caller = new AbortController()
    const cancel = spyOn(f.domain, "cancel")
    const steer = f.domain.steer
    spyOn(f.domain, "steer").mockImplementation(async (input, options) => {
      const admitted = await steer(input, options)
      caller.abort(new Error("caller interrupted"))
      return admitted
    })

    const receipt = await createDelegateTask({
      manager: f.manager,
      client: f.input.client,
      directory: f.input.directory,
    }).execute(
      {
        task_id: task.sessionId ?? "",
        prompt: "clarify",
        description: "continue",
        run_in_background: false,
        load_skills: [],
      },
      {
        sessionID: "parent",
        messageID: "foreground-message",
        agent: "parent-agent",
        callID: "foreground-steer",
        abort: caller.signal,
        directory: f.input.directory,
        worktree: f.input.directory,
        ask: async () => {},
        metadata: async () => {},
      },
    )

    expect(receipt).toContain(`Background Task ID: ${task.id}`)
    expect(receipt).not.toContain("child result")
    expect(cancel).not.toHaveBeenCalled()
    expect(f.manager.getTask(task.id)?.status).toBe("running")
    expect(f.manager.getTask(task.id)?.nativeRun).toEqual(originalRun)
    expect(f.rows.get(originalAdmission)).toMatchObject({ status: "running", completion: "parent" })
    const completion = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(originalAdmission)
    expect(await completion).toMatchObject({ status: "completed", result: "child result" })
    expect(f.starts).toEqual([task.sessionId])
    expect(cancel).not.toHaveBeenCalled()
  })

  it("waits for a foreground successor when the original generation closes before steer", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const wait = f.domain.wait
    spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observing.resolve()
      return wait(input)
    })
    const task = await f.manager.launch({ ...f.launch("foreground-successor"), nativeCompletion: "parent" })
    await observing.promise
    const originalAdmission = task.nativeAdmissionID ?? ""
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const steer = f.domain.steer
    spyOn(f.domain, "steer").mockImplementation(async (input, options) => {
      entered.resolve()
      await release.promise
      return steer(input, options)
    })
    const nextStart = f.nextStart()
    const reply = createDelegateTask({
      manager: f.manager,
      client: f.input.client,
      directory: f.input.directory,
    }).execute(
      {
        task_id: task.sessionId ?? "",
        prompt: "clarify",
        description: "continue",
        run_in_background: false,
        load_skills: [],
      },
      {
        sessionID: "parent",
        messageID: "successor-message",
        agent: "parent-agent",
        callID: "successor",
        abort: new AbortController().signal,
        directory: f.input.directory,
        worktree: f.input.directory,
        ask: async () => {},
        metadata: async () => {},
      },
    )
    await entered.promise
    f.finish(originalAdmission)
    release.resolve()
    await nextStart
    const successorAdmission = f.manager.getTask(task.id)?.nativeAdmissionID ?? ""
    expect(successorAdmission).not.toBe(originalAdmission)
    expect(f.rows.get(successorAdmission)?.completion).toBe("none")
    f.finish(successorAdmission)
    const result = await reply
    expect(result).toContain("child result")
    expect(result).not.toContain("Background Task ID:")
  })

  it("cancels the running child while steer authorization is pending", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const wait = f.domain.wait
    spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observing.resolve()
      return wait(input)
    })
    const task = await f.manager.launch(f.launch("cancel-steer"))
    await observing.promise
    const admission = task.nativeAdmissionID ?? ""
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const steer = f.domain.steer
    spyOn(f.domain, "steer").mockImplementation(async (input, options) => {
      entered.resolve()
      await release.promise
      return steer(input, options)
    })
    const caller = new AbortController()
    const steering = f.manager.resume({
      sessionId: task.sessionId ?? "",
      parentSessionId: "parent",
      parentMessageId: "next",
      prompt: "clarify",
      nativeSignal: caller.signal,
      nativeInvocation: { kind: "tool", agent: "parent-agent", messageID: "next", toolCallID: "steer" },
    })
    const settledSteering = steering.then(
      () => "started",
      () => "aborted",
    )
    await entered.promise
    const cancellation = f.manager.cancelTask(task.id)
    const deadline = AbortSignal.timeout(2000)
    try {
      await Promise.race([
        cancellation,
        new Promise<never>((_, reject) =>
          deadline.addEventListener("abort", () => reject(new Error("Cancellation did not abort steer admission")), {
            once: true,
          }),
        ),
      ])
      expect(f.rows.get(admission)?.status).toBe("cancelled")
      expect(f.starts).toEqual([task.sessionId])
    } finally {
      release.resolve()
      await Promise.allSettled([steering, cancellation])
    }
    expect(await settledSteering).toBe("aborted")
  })

  it("reconciles a lost steer response without changing durable ownership", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const wait = f.domain.wait
    spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observing.resolve()
      return wait(input)
    })
    const task = await f.manager.launch(f.launch("failed-steer"))
    await observing.promise
    const original = backgroundTaskRecord.parse(f.stored.get(task.id))
    const steer = f.domain.steer
    let lost = true
    spyOn(f.domain, "steer").mockImplementation(async (input, options) => {
      const result = await steer(input, options)
      if (lost) {
        lost = false
        throw new Error("steer response lost")
      }
      return result
    })
    const resume = {
      sessionId: task.sessionId ?? "",
      parentSessionId: "parent",
      parentMessageId: "next",
      prompt: "clarify",
      nativeInvocation: { kind: "tool" as const, agent: "parent-agent", messageID: "next", toolCallID: "steer" },
    }
    await expect(f.manager.resume(resume)).rejects.toThrow("steer response lost")
    await f.manager.resume(resume)
    expect(f.prompts).toHaveLength(2)
    expect(f.starts).toEqual([task.sessionId])
    const restored = backgroundTaskRecord.parse(f.stored.get(task.id))
    await f.createJobs().restore([restored], async () => {})
    expect(restored).toMatchObject({
      status: "running",
      nativeAdmissionID: original.nativeAdmissionID,
      nativeRun: original.nativeRun,
    })
    const completion = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(original.nativeAdmissionID ?? "")
    await completion
    await f.manager.resume(resume)
    expect(f.prompts).toHaveLength(2)
    expect(f.starts).toEqual([task.sessionId])
  })

  it("releases a closed steer reservation before settling and starting a continuation", async () => {
    const f = await fixture()
    const observing = Promise.withResolvers<void>()
    const observingNext = Promise.withResolvers<void>()
    const wait = f.domain.wait
    let observed = 0
    spyOn(f.domain, "wait").mockImplementation(async (input) => {
      observed += 1
      if (observed === 1) observing.resolve()
      if (observed === 2) observingNext.resolve()
      return wait(input)
    })
    const task = await f.manager.launch(f.launch("close-before-steer"))
    await observing.promise
    const originalAdmission = task.nativeAdmissionID ?? ""
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const steer = f.domain.steer
    spyOn(f.domain, "steer").mockImplementation(async (input, options) => {
      entered.resolve()
      await release.promise
      return steer(input, options)
    })
    const nextStart = f.nextStart()
    const input = {
      sessionId: task.sessionId ?? "",
      parentSessionId: "parent",
      parentMessageId: "next",
      prompt: "clarify",
      nativeInvocation: { kind: "tool" as const, agent: "parent-agent", messageID: "next", toolCallID: "steer" },
    }
    const continuation = f.manager.resume(input)
    await entered.promise
    const duplicate = f.manager.resume(input)
    f.finish(originalAdmission)
    release.resolve()
    const resumed = await continuation
    expect(await duplicate).toBe(resumed)
    await nextStart
    await observingNext.promise
    expect(resumed.nativeAdmissionID).not.toBe(originalAdmission)
    expect(f.starts).toEqual([task.sessionId, task.sessionId])
    expect(f.prompts).toHaveLength(2)
    await f.manager.resume(input)
    expect(f.prompts).toHaveLength(2)
  })

  it("steers a team member without replacing its session or acquiring a second permit", async () => {
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch({
      ...f.launch("member"),
      teamRunId: "team",
      nativeCompletion: "none",
      nativeInvocation: {
        kind: "tool",
        agent: "parent-agent",
        messageID: "message",
        toolCallID: "member",
        team: { teamRunID: "team", member: "worker" },
      },
    })
    await started
    const steered = f.nextStart()
    const delivery = f.manager.resume({
      sessionId: task.sessionId ?? "",
      parentSessionId: "parent",
      parentMessageId: "mail",
      prompt: "mailbox",
      nativeInvocation: {
        kind: "team",
        agent: "parent-agent",
        teamRunID: "team",
        member: "worker",
        invocationID: "mail",
        provisioningAdmissionID: task.nativeAdmissionID ?? "",
      },
    })
    await steered
    await delivery
    expect(f.manager.getTask(task.id)?.nativeRun).toEqual({ childSessionID: "child-1", generation: "1" })
    expect(f.starts).toEqual(["child-1", "child-1"])
    const pending = await f.manager.launch(f.launch("other"))
    expect(pending.status).toBe("pending")
    const result = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(f.manager.getTask(task.id)?.nativeAdmissionID ?? "")
    expect((await result).status).toBe("completed")
  })

  it("revokes a completed member's provisioning anchor on membership end without rewriting its result", async () => {
    // given a team member whose provisioning run already completed
    const f = await fixture()
    const started = f.nextStart()
    const task = await f.manager.launch({
      ...f.launch("member"),
      teamRunId: "team",
      nativeCompletion: "none",
      nativeInvocation: {
        kind: "tool",
        agent: "parent-agent",
        messageID: "message",
        toolCallID: "member",
        team: { teamRunID: "team", member: "worker" },
      },
    })
    await started
    const anchor = task.nativeProvisioningAdmissionID ?? ""
    const result = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(anchor)
    expect((await result).status).toBe("completed")

    // when membership ends
    await f.manager.cancelTask(task.id, {
      source: "team-remove-member",
      skipNotification: true,
      revokeTeamProvisioning: true,
    })

    // then the anchor is revoked, history stays, and later mailbox admission fails
    expect(f.rows.get(anchor)).toMatchObject({ status: "completed", output: "child result", revoked: true })
    expect(f.manager.getTask(task.id)?.status).toBe("completed")
    await expect(
      f.manager.resume({
        sessionId: task.sessionId ?? "",
        parentSessionId: "parent",
        parentMessageId: "mail",
        prompt: "mailbox",
        nativeInvocation: {
          kind: "team",
          agent: "parent-agent",
          teamRunID: "team",
          member: "worker",
          invocationID: "mail",
          provisioningAdmissionID: anchor,
        },
      }),
    ).rejects.toThrow("Provisioning anchor revoked")
    expect(f.starts).toEqual(["child-1"])
  })
})

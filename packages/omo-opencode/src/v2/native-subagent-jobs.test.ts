import { afterEach, describe, expect, it } from "bun:test"
import { BackgroundManager } from "../features/background-agent/manager"
import type { NativeDelegationSkills } from "./native-subagent-jobs"
import { backgroundTaskRecord } from "./background-task-record"
import { cleanupNativeFixtures, cleanups, fixture } from "./native-subagent-jobs-test-fixture"

afterEach(cleanupNativeFixtures)

describe("native subagent consumer", () => {
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
    const started = f.nextStart()
    const task = await f.manager.launch(f.launch("first"))
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
    const result = f.manager.waitForNativeTask(task.id, new AbortController().signal)
    f.finish(f.manager.getTask(task.id)?.nativeAdmissionID ?? "")
    await result
    expect(f.starts).toEqual(["child-1", "child-1"])
    expect(f.manager.getTask(task.id)?.nativeRun).toEqual({ childSessionID: "child-1", generation: "2" })
    expect(f.manager.getTask(task.id)?.attempts).toHaveLength(2)
  })

  it.each(["running", "completed"] as const)(
    "restores permits before acknowledging recovered %s generation",
    async (status) => {
      const f = await fixture()
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
        return
      }
      expect(queued.status).toBe("pending")
      expect(f.starts).toEqual(["child-1"])
      const next = f.nextStart()
      f.finish(task.nativeAdmissionID ?? "")
      await next
      expect(f.starts).toEqual(["child-1", "child-2"])
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

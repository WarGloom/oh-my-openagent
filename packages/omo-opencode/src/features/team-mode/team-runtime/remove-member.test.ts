/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import { RuntimeStateSchema } from "@oh-my-opencode/team-core/types"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { clearTeamSessionRegistry, configureTeamSessionRemoval, isTeamSessionDenied, isKnownTeamSession, lookupTeamSession, registerTeamSession } from "../team-session-registry"
import type { BackgroundTask } from "../../background-agent/types"
import { admitAddedMember } from "@oh-my-opencode/team-core/team-state-store/member-admission"
import { findResolvedMemberSession } from "../member-session-resolution"
import { resolveParticipant } from "../tools/lifecycle-participant"
import { listActiveTeams } from "../team-state-store/store"
import { withDispatchTimeout } from "@oh-my-opencode/utils/prompt-async-gate/timing"
import { createRemovalTestContext } from "./remove-member.test-support"

const { fixture, cleanup } = createRemovalTestContext()
afterEach(cleanup)

describe("removal storage protocol", () => {
  test("older strict writers reject the permanent lead marker before and after archival", async () => {
    // given
    const input = await fixture()
    const oldMember = RuntimeStateSchema.shape.members.element.omit({ removal: true, removalProtocolVersion: true })
    const oldState = RuntimeStateSchema.omit({ removedMembers: true })
    const { beginTeamMemberRemoval } = await import("./remove-member")
    // when
    await beginTeamMemberRemoval(input)
    const fenced = await loadRuntimeState(input.teamRunId, input.config)
    const oldSchema = oldState.extend({ members: oldMember.array() })
    const worker = fenced.members.find(member => member.name === "worker")
    if (!worker?.removal) throw new Error("worker reservation missing")
    const archived = { ...fenced, members: fenced.members.filter(member => member.name !== "worker"), removedMembers: [
      { member: worker, operationId: worker.removal.operationId, removedAt: 1, requeuedTaskIds: [] },
    ] }
    // then
    expect(oldSchema.safeParse(fenced).success).toBe(false)
    expect(oldSchema.safeParse(archived).success).toBe(false)
    expect(RuntimeStateSchema.safeParse(archived).success).toBe(true)
  })
  test("legacy state defaults history without enabling removal", async () => {
    // given / when
    const { state } = await fixture()
    const { removedMembers: _history, ...legacy } = state
    const parsed = RuntimeStateSchema.parse(legacy)
    // then
    expect(parsed).toMatchObject({ removedMembers: [] })
    expect(parsed.members[0]).not.toHaveProperty("removalProtocolVersion")
  })

  test("strict member accepts only the supported removal protocol", async () => {
    // given
    const { state } = await fixture()
    const removal = { operationId: crypto.randomUUID(), sessionId: "worker-session", startedAt: 1, phase: "fenced", taskIds: [] }
    // when / then
    expect(RuntimeStateSchema.safeParse({ ...state, members: state.members.map(member => member.name === "worker" ? { ...member, removal } : { ...member, removalProtocolVersion: 1 }) }).success).toBe(true)
    expect(RuntimeStateSchema.safeParse({ ...state, members: [{ ...state.members[0], removalProtocolVersion: 2 }] }).success).toBe(false)
  })
})

describe("beginTeamMemberRemoval", () => {
  test.each(["stale-cache", "restart", "archive"])("denies %s identity at durable participant boundaries", async scenario => {
    // given
    const input = await fixture()
    registerTeamSession("worker-session", { teamRunId: input.teamRunId, memberName: "worker", role: "member" })
    const { beginTeamMemberRemoval } = await import("./remove-member")
    await beginTeamMemberRemoval(input)
    if (scenario !== "stale-cache") clearTeamSessionRegistry()
    if (scenario === "archive") await transitionRuntimeState(input.teamRunId, current => {
      const member = current.members.find(candidate => candidate.name === "worker")
      if (!member?.removal) throw new Error("reservation missing")
      return { ...current, members: current.members.filter(candidate => candidate.name !== "worker"), removedMembers: [
        { member, operationId: member.removal.operationId, removedAt: 1, requeuedTaskIds: [] },
      ] }
    }, input.config)
    configureTeamSessionRemoval(input.config)
    // when / then
    expect(isTeamSessionDenied("worker-session")).toBe(true)
    expect(isKnownTeamSession("worker-session")).toBe(true)
    registerTeamSession("worker-session", { teamRunId: input.teamRunId, memberName: "worker", role: "member" })
    expect(lookupTeamSession("worker-session")).toBeUndefined()
    expect(await findResolvedMemberSession("worker-session", input.config, "removal-test")).toBeNull()
    await expect(resolveParticipant(input.teamRunId, "worker-session", input.config, { loadRuntimeState, listActiveTeams })).rejects.toThrow()
    if (scenario === "restart") {
      const program = `
        import { configureTeamSessionRemoval, isTeamSessionDenied, registerTeamSession, lookupTeamSession } from ${JSON.stringify(new URL("../team-session-registry.ts", import.meta.url).href)};
        configureTeamSessionRemoval(${JSON.stringify(input.config)});
        registerTeamSession("worker-session", ${JSON.stringify({ teamRunId: input.teamRunId, memberName: "worker", role: "member" })});
        console.log(JSON.stringify({ denied: isTeamSessionDenied("worker-session"), active: lookupTeamSession("worker-session") !== undefined }));
      `
      const child = Bun.spawn([process.execPath, "-e", program], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
      try {
        expect(await withDispatchTimeout(child.exited, 1000, "fresh process removal denial")).toBe(0)
        expect(await new Response(child.stdout).text()).toBe('{"denied":true,"active":false}\n')
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }
  })

  test("reserves archived names without counting archived capacity", async () => {
    // given
    const { state } = await fixture()
    const member = state.members.find(candidate => candidate.name === "worker")
    if (!member) throw new Error("worker missing")
    const archived = RuntimeStateSchema.parse({ ...state, members: state.members.filter(candidate => candidate.name !== "worker"), removedMembers: [
      { member, operationId: crypto.randomUUID(), removedAt: 1, requeuedTaskIds: [] },
    ] })
    // when / then
    expect(() => admitAddedMember(archived, "worker", "claim")).toThrow()
    expect(admitAddedMember(archived, "fresh", "claim").member.name).toBe("fresh")
  })
  test.each(["authority", "lead", "unknown", "inactive", "provisioning", "unresolved"])("rejects %s before reservation", async scenario => {
    // given
    const input = await fixture()
    if (scenario === "inactive" || scenario === "provisioning" || scenario === "unresolved") {
      await transitionRuntimeState(input.teamRunId, state => ({ ...state,
        status: scenario === "inactive" ? "shutdown_requested" : state.status,
        members: state.members.map(member => member.name !== "worker" ? member : { ...member,
          provisioningClaimId: scenario === "provisioning" ? "claim" : undefined,
          sessionId: scenario === "unresolved" ? undefined : member.sessionId,
        }),
      }), input.config)
    }
    const before = await loadRuntimeState(input.teamRunId, input.config)
    const { beginTeamMemberRemoval } = await import("./remove-member")
    // when / then
    await expect(beginTeamMemberRemoval({ ...input,
      leadSessionId: scenario === "authority" ? "worker-session" : input.leadSessionId,
      memberName: scenario === "lead" ? "lead" : scenario === "unknown" ? "unknown" : "worker",
    })).rejects.toThrow()
    expect(await loadRuntimeState(input.teamRunId, input.config)).toEqual(before)
  })

  test("durably fences while retaining capacity and the same retry operation", async () => {
    // given
    const input = await fixture()
    registerTeamSession("worker-session", { teamRunId: input.teamRunId, memberName: "worker", role: "member" })
    const { beginTeamMemberRemoval } = await import("./remove-member")
    // when
    const first = await beginTeamMemberRemoval(input)
    const retry = await beginTeamMemberRemoval(input)
    // then
    expect(retry).toEqual(first)
    const stored = await loadRuntimeState(input.teamRunId, input.config)
    expect(stored.members).toHaveLength(2)
    expect(stored.members.find(member => member.name === "worker")).toMatchObject({ removal: first })
    expect(stored.members.find(member => member.name === "lead")).toMatchObject({ removalProtocolVersion: 1 })
    expect(lookupTeamSession("worker-session")).toBeUndefined()
  })
})

describe("stopTeamMemberRemoval", () => {
  test.each(["success", "error", "timeout", "absent", "wrong-session", "terminal", "pending", "direct-response-error", "false-response", "not-found", "wrong-reread", "false-terminal"])("requires exact stop proof for %s", async scenario => {
    // given
    const input = await fixture()
    const tracked: Pick<BackgroundTask, "id" | "sessionId" | "status"> = {
      id: "background-worker", sessionId: scenario === "wrong-session" ? "other-session" : "worker-session",
      status: scenario === "terminal" ? "completed" : scenario === "pending" ? "pending" : "running",
    }
    const aborts: string[] = []
    const cancellations: unknown[] = []
    const lookups: string[] = []
    const client = { session: { abort: async ({ path: target }: { path: { id: string } }) => {
      aborts.push(target.id)
      if (scenario === "error") return { error: new Error("abort refused") }
      if (scenario === "direct-response-error" || scenario === "false-terminal") return { error: { status: 500 } }
      if (scenario === "false-response") return { data: false }
      if (scenario === "not-found") return { error: { status: 404 } }
      if (scenario === "timeout") return new Promise<never>(() => {})
      return undefined
    } } }
    const bgMgr = {
      findBySession: (sessionId: string) => {
        lookups.push(sessionId)
        return ["absent", "timeout", "direct-response-error", "false-response", "not-found"].includes(scenario) ? undefined : tracked
      },
      getTask: () => scenario === "wrong-reread" ? { ...tracked, sessionId: "foreign-session" } : tracked,
      cancelTask: async (id: string, options?: { abortSession?: boolean; skipNotification?: boolean }) => {
        cancellations.push({ id, ...options })
        if (scenario === "error" || scenario === "timeout") return false
        tracked.status = "cancelled"
        return scenario !== "false-terminal"
      },
    }
    const { stopTeamMemberRemoval } = await import("./remove-member")
    // when
    const result = await stopTeamMemberRemoval({ ...input, client, bgMgr, stopTimeoutMs: 1 }).then(value => ({ value }), error => ({ error }))
    // then
    const stored = await loadRuntimeState(input.teamRunId, input.config)
    const removal = stored.members.find(member => member.name === "worker")?.removal
    expect(stored.members).toHaveLength(2)
    expect(lookups).toEqual(["worker-session"])
    if (["error", "timeout", "wrong-session", "direct-response-error", "false-response", "wrong-reread", "false-terminal"].includes(scenario)) {
      expect(result).toHaveProperty("error")
      expect(removal?.phase).toBe("fenced")
    } else {
      expect(result).toHaveProperty("value")
      expect(removal?.phase).toBe("stopped")
    }
    if (["absent", "terminal", "pending", "not-found", "direct-response-error", "false-response", "timeout", "false-terminal"].includes(scenario)) expect(aborts).toEqual(["worker-session"])
    if (scenario === "wrong-session") expect(cancellations).toEqual([])
    if (scenario === "success") expect(cancellations).toEqual([{ id: "background-worker", abortSession: true, skipNotification: true, source: "team-remove-member" }])
  })
})

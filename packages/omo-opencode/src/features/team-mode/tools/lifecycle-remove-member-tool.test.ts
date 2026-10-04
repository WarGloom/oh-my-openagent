import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { createRemovalTestContext } from "../team-runtime/remove-member.test-support"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { admitAddedMember } from "@oh-my-opencode/team-core/team-state-store/member-admission"
import { createTask } from "@oh-my-opencode/team-core/team-tasklist/store"
import { createTaskInput } from "@oh-my-opencode/team-core/team-tasklist/test-support"
import { claimTask } from "@oh-my-opencode/team-core/team-tasklist/claim"
import { getTask } from "@oh-my-opencode/team-core/team-tasklist/get"
import { createToolContext } from "./lifecycle-test-fixture"
import { createTeamRemoveMemberTool } from "./lifecycle-remove-member-tool"
import { aggregateStatus } from "../team-runtime/status"
import { beginTeamMemberRemoval, finishTeamMemberRemoval } from "../team-runtime/remove-member"
import { approveShutdown, rejectShutdown } from "../team-runtime/shutdown"
import { createTeamSendMessageTool } from "./messaging"
import { getAgentToolRestrictions } from "../../../shared/agent-tool-restrictions"
import { registerTeamSession } from "../team-session-registry"

const { fixture, cleanup } = createRemovalTestContext()
afterEach(cleanup)
const manager = { findBySession: () => undefined, getTask: () => undefined, cancelTask: async () => true }
const client = { session: { abort: async () => true } }
const receiptSchema = z.object({
  teamRunId: z.uuid(),
  memberName: z.string(),
  removalId: z.uuid(),
  removed: z.literal(true),
  requeuedTaskIds: z.array(z.string()),
})

describe("team_remove_member public execution", () => {
  test("publishes a receipt at capacity and admits a fresh owner for the preserved task", async () => {
    // given
    const input = await fixture()
    await transitionRuntimeState(
      input.teamRunId,
      (state) => ({ ...state, bounds: { ...state.bounds, maxMembers: 2 } }),
      input.config,
    )
    const task = await createTask(
      input.teamRunId,
      createTaskInput({ status: "in_progress", owner: "worker", metadata: { partial: "kept" } }),
      input.config,
    )
    const tool = createTeamRemoveMemberTool(input.config, client, manager)
    // when
    const result = await tool.execute(
      { teamRunId: input.teamRunId, memberName: "worker" },
      createToolContext("lead-session"),
    )
    // then
    const receipt = receiptSchema.parse(JSON.parse(typeof result === "string" ? result : result.output))
    const state = await loadRuntimeState(input.teamRunId, input.config)
    expect(receipt).toMatchObject({
      teamRunId: input.teamRunId,
      memberName: "worker",
      removed: true,
      requeuedTaskIds: [task.id],
    })
    expect(state.removedMembers?.[0]?.operationId).toBe(receipt.removalId)
    await transitionRuntimeState(
      input.teamRunId,
      (current) => ({
        ...current,
        members: [...current.members, admitAddedMember(current, "fresh", "fresh-claim").member],
      }),
      input.config,
    )
    const claimed = await claimTask(input.teamRunId, task.id, "fresh", input.config)
    expect(claimed).toMatchObject({ owner: "fresh", status: "claimed", metadata: { partial: "kept" } })
    expect(() => admitAddedMember(state, "worker", "old-name")).toThrow()
  })

  test("exact retry returns the published receipt without requeuing fresh work", async () => {
    // given
    const input = await fixture()
    const tool = createTeamRemoveMemberTool(input.config, client, manager)
    const args = { teamRunId: input.teamRunId, memberName: "worker" }
    const prior = await tool.execute(args, createToolContext("lead-session"))
    const task = await createTask(input.teamRunId, createTaskInput({ status: "claimed", owner: "fresh" }), input.config)
    // when
    const retry = await tool.execute(args, createToolContext("lead-session"))
    // then
    expect(retry).toEqual(prior)
    expect(await getTask(input.teamRunId, task.id, input.config)).toEqual(task)
    expect((await loadRuntimeState(input.teamRunId, input.config)).removedMembers).toHaveLength(1)
  })

  test.each(["worker-session", "outside-session", ""])("rejects non-lead trusted context %s", async (sessionID) => {
    // given
    const input = await fixture()
    const tool = createTeamRemoveMemberTool(input.config, client, manager)
    // when / then
    await expect(
      tool.execute(
        { teamRunId: input.teamRunId, memberName: "worker", leadSessionId: "lead-session", role: "lead" },
        createToolContext(sessionID),
      ),
    ).rejects.toThrow()
    expect(await loadRuntimeState(input.teamRunId, input.config)).toEqual(input.state)
  })

  test.each(["lead", "missing"])("rejects target %s without changing the run", async (memberName) => {
    // given
    const input = await fixture()
    // when / then
    await expect(
      createTeamRemoveMemberTool(input.config, client, manager).execute(
        { teamRunId: input.teamRunId, memberName },
        createToolContext("lead-session"),
      ),
    ).rejects.toThrow()
    expect(await loadRuntimeState(input.teamRunId, input.config)).toEqual(input.state)
  })

  test.each([
    { teamRunId: "../run", memberName: "worker" },
    { teamRunId: "", memberName: "worker" },
    { memberName: "../worker" },
    { memberName: "" },
  ])("rejects malformed input %j before fencing", async (invalid) => {
    // given
    const input = await fixture()
    // when / then
    await expect(
      createTeamRemoveMemberTool(input.config, client, manager).execute(
        { teamRunId: input.teamRunId, ...invalid },
        createToolContext("lead-session"),
      ),
    ).rejects.toThrow()
    expect(await loadRuntimeState(input.teamRunId, input.config)).toEqual(input.state)
  })

  test("rejects completed retry once the run is inactive", async () => {
    // given
    const input = await fixture()
    const tool = createTeamRemoveMemberTool(input.config, client, manager)
    const args = { teamRunId: input.teamRunId, memberName: "worker" }
    await tool.execute(args, createToolContext("lead-session"))
    await transitionRuntimeState(input.teamRunId, (state) => ({ ...state, status: "shutdown_requested" }), input.config)
    // when / then
    await expect(tool.execute(args, createToolContext("lead-session"))).rejects.toThrow()
  })

  test("rejects provisioning without reserving removal", async () => {
    // given
    const input = await fixture()
    const state = await transitionRuntimeState(
      input.teamRunId,
      (current) => ({
        ...current,
        members: current.members.map((m) => (m.name === "worker" ? { ...m, provisioningClaimId: "pending" } : m)),
      }),
      input.config,
    )
    // when / then
    await expect(
      createTeamRemoveMemberTool(input.config, client, manager).execute(
        { teamRunId: input.teamRunId, memberName: "worker" },
        createToolContext("lead-session"),
      ),
    ).rejects.toMatchObject({ stage: "provisioning", retryable: false })
    expect(await loadRuntimeState(input.teamRunId, input.config)).toEqual(state)
  })

  test("ignores a stale registry lead role when the durable lead session differs", async () => {
    // given
    const input = await fixture()
    registerTeamSession("worker-session", { teamRunId: input.teamRunId, memberName: "worker", role: "lead" })
    // when / then
    await expect(
      createTeamRemoveMemberTool(input.config, client, manager).execute(
        { teamRunId: input.teamRunId, memberName: "worker" },
        createToolContext("worker-session"),
      ),
    ).rejects.toMatchObject({ stage: "authority", retryable: false })
  })

  test("reports retryable stop failure with operation identity and never returns success", async () => {
    // given
    const input = await fixture()
    const tool = createTeamRemoveMemberTool(input.config, { session: { abort: async () => false } }, manager)
    // when
    const failure = await tool
      .execute({ teamRunId: input.teamRunId, memberName: "worker" }, createToolContext("lead-session"))
      .catch((error: unknown) => error)
    // then
    const state = await loadRuntimeState(input.teamRunId, input.config)
    expect(failure).toMatchObject({
      stage: "stop_unverified",
      removalId: state.members.find((m) => m.name === "worker")?.removal?.operationId,
      retryable: true,
    })
    expect(state.members).toHaveLength(2)
    expect(state.removedMembers).toEqual([])
  })

  test("denies stale removed-session execution and keeps ordinary agent advertisement restricted", async () => {
    // given
    const input = await fixture()
    const tool = createTeamRemoveMemberTool(input.config, client, manager)
    await tool.execute({ teamRunId: input.teamRunId, memberName: "worker" }, createToolContext("lead-session"))
    // when / then
    await expect(
      tool.execute({ teamRunId: input.teamRunId, memberName: "lead" }, createToolContext("worker-session")),
    ).rejects.toThrow()
    expect(getAgentToolRestrictions("sisyphus")["team_remove_member"]).toBe(false)
    expect(getAgentToolRestrictions("sisyphus", { includeTeamToolDenylist: false })).not.toHaveProperty(
      "team_remove_member",
    )
  })
})

describe("retired-member adapter projections", () => {
  test("status exposes pending removal and then archived session/worktree identity outside the active roster", async () => {
    // given
    const input = await fixture()
    await transitionRuntimeState(
      input.teamRunId,
      (state) => ({
        ...state,
        members: state.members.map((m) =>
          m.name === "worker"
            ? {
                ...m,
                worktreePath: `${input.config.base_dir}/worker`,
                tmuxPaneId: "%4",
                pendingInjectedMessageIds: ["kept"],
              }
            : m,
        ),
      }),
      input.config,
    )
    const pending = await beginTeamMemberRemoval(input)
    expect(
      (await aggregateStatus(input.teamRunId, input.config)).members.find((m) => m.name === "worker")?.removal,
    ).toEqual(pending)
    // when
    const receipt = await finishTeamMemberRemoval({ ...input, client, bgMgr: manager })
    const status = await aggregateStatus(input.teamRunId, input.config)
    // then
    expect(status.members.map((m) => m.name)).toEqual(["lead"])
    expect(status.removedMembers).toEqual([receipt])
    expect(status.removedMembers[0]?.member).toMatchObject({
      sessionId: "worker-session",
      tmuxPaneId: "%4",
      worktreePath: `${input.config.base_dir}/worker`,
      pendingInjectedMessageIds: ["kept"],
    })
  })

  test.each(["fenced", "removed"])("rejects direct sends to %s names and skips them on broadcast", async (phase) => {
    // given
    const input = await fixture()
    await transitionRuntimeState(
      input.teamRunId,
      (state) => ({
        ...state,
        members: [
          ...state.members,
          {
            name: "other",
            sessionId: "other-session",
            agentType: "general-purpose",
            status: "running",
            pendingInjectedMessageIds: [],
          },
        ],
      }),
      input.config,
    )
    if (phase === "fenced") await beginTeamMemberRemoval(input)
    else await finishTeamMemberRemoval({ ...input, client, bgMgr: manager })
    const send = createTeamSendMessageTool(input.config, { session: { promptAsync: async () => ({ data: {} }) } })
    // when / then
    await expect(
      send.execute({ teamRunId: input.teamRunId, to: "worker", body: "forbidden" }, createToolContext("lead-session")),
    ).rejects.toThrow("unknown or inactive team recipient")
    const result = await send.execute(
      { teamRunId: input.teamRunId, to: "*", body: "hello" },
      createToolContext("lead-session"),
    )
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({ deliveredTo: ["other"] })
  })

  test.each(["approve", "reject"])(
    "%s fails for a removed target without mutating retained shutdown requests",
    async (action) => {
      // given
      const input = await fixture()
      const request = { memberId: "worker", requesterName: "lead", requestedAt: 1 }
      await transitionRuntimeState(
        input.teamRunId,
        (state) => ({ ...state, shutdownRequests: [request] }),
        input.config,
      )
      await finishTeamMemberRemoval({ ...input, client, bgMgr: manager })
      // when / then
      const result =
        action === "approve"
          ? approveShutdown(input.teamRunId, "worker", "lead", input.config)
          : rejectShutdown(input.teamRunId, "worker", "lead", "keep", input.config)
      await expect(result).rejects.toThrow("unknown member 'worker'")
      expect((await loadRuntimeState(input.teamRunId, input.config)).shutdownRequests).toEqual([request])
    },
  )
})

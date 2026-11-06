/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { sendMessage } from "../team-mailbox/send"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import * as runtimeStateStore from "../team-state-store/store"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import type { DeleteTeamDeps } from "./delete-team"
import {
  createFixture,
  createNativeFixture,
  createTestMessage,
  readInboxMessages,
  updateMemberStatuses,
} from "./shutdown-test-fixtures"
import {
  clearSessionTeamRunCleanupRegistry,
  getSessionCreatedTeamRunIds,
  registerTeamRunForSessionCleanup,
} from "./session-cleanup"

const { approveShutdown, deleteTeam, rejectShutdown, requestShutdownOfMember } = await import("./shutdown")
import { removeMemberWorktrees } from "./shutdown-helpers"
import { bindNativeTeamWorktrees } from "../../../v2/native-team-worktrees"

describe("team-runtime shutdown", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directoryPath) => {
        await rm(directoryPath, { recursive: true, force: true })
      }),
    )
    clearSessionTeamRunCleanupRegistry()
    mock.restore()
  })

  for (const condition of [
    "dirty",
    "dirty-tracked",
    "dirty-ignored",
    "unintegrated",
    "local-branch",
    "tag-only",
    "remote-only",
    "old-integrated",
    "old-merged",
    "old-unintegrated",
    "foreign-source",
    "integrated",
  ] as const) {
    test(`native cleanup preserves work unless clean and integrated (${condition})`, async () => {
      // given
      const fixture = await createNativeFixture()
      temporaryDirectories.push(fixture.baseDir)
      const directory = fixture.worktreePaths[0]
      if (!directory) throw new Error("missing member worktree")
      if (condition === "dirty") await writeFile(path.join(directory, "member-work.txt"), "unfinished work")
      if (condition === "dirty-tracked") {
        const tracked = (await fixture.git(directory, "ls-files")).split("\n")[0]
        if (!tracked) throw new Error("missing tracked fixture file")
        await writeFile(path.join(directory, tracked), "unfinished tracked work")
      }
      if (condition === "dirty-ignored") {
        const exclude = await fixture.git(directory, "rev-parse", "--git-path", "info/exclude")
        await writeFile(exclude, "ignored-work.txt\n")
        await writeFile(path.join(directory, "ignored-work.txt"), "unfinished ignored work")
      }
      if (
        ["unintegrated", "local-branch", "tag-only", "remote-only", "old-merged", "old-unintegrated"].includes(
          condition,
        )
      ) {
        await fixture.git(directory, "switch", "--detach", fixture.next)
      }
      if (condition === "local-branch") {
        await fixture.git(
          directory,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "--allow-empty",
          "-m",
          "saved descendant",
        )
        await fixture.git(directory, "branch", "saved-member", "HEAD")
        await fixture.git(directory, "switch", "--detach", fixture.next)
      }
      if (condition === "tag-only") await fixture.git(directory, "tag", "member-backup", fixture.next)
      if (condition === "remote-only")
        await fixture.git(directory, "update-ref", "refs/remotes/origin/member", fixture.next)
      if (condition === "old-merged") await fixture.git(fixture.directory, "merge", fixture.next)
      const foreignSource = path.join(fixture.baseDir, "foreign-source")
      if (condition === "foreign-source") {
        await mkdir(foreignSource)
        await fixture.git(foreignSource, "init", "--quiet")
        await fixture.git(
          foreignSource,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "--allow-empty",
          "-m",
          "foreign repository",
        )
      }
      const state = await loadRuntimeState(fixture.teamRunId, fixture.config)
      const member = state.members[1]
      if (!member) throw new Error("missing member")
      const resource =
        condition.startsWith("old-") && member.nativeWorktree
          ? { ...member, nativeWorktree: { projectID: member.nativeWorktree.projectID, directory } }
          : condition === "foreign-source" && member.nativeWorktree
            ? { ...member, nativeWorktree: { ...member.nativeWorktree, sourceDirectory: foreignSource } }
            : member

      // when
      const result = await removeMemberWorktrees([resource], fixture.owner)

      // then
      if (["integrated", "dirty-ignored", "local-branch", "old-integrated", "old-merged"].includes(condition)) {
        expect(fixture.removals).toEqual([false])
        expect(result.keptWorktrees).toEqual([])
        await expect(access(directory)).rejects.toThrow()
      } else {
        expect(fixture.removals).toEqual([])
        await access(directory)
        const expectedReason = condition.startsWith("dirty")
          ? "dirty"
          : condition === "foreign-source"
            ? "inspection failed"
            : "unintegrated"
        expect(result).toMatchObject({
          keptWorktrees: [{ directory, reason: expect.stringContaining(expectedReason) }],
        })
        if (condition === "unintegrated")
          expect(result).toMatchObject({
            keptWorktrees: [{ sha: fixture.next, shortSha: fixture.next.slice(0, 12), ahead: 1 }],
          })
      }
    })
  }

  test("native preflight refuses before changing team state or removing any worktree even with force", async () => {
    // given
    const fixture = await createNativeFixture()
    temporaryDirectories.push(fixture.baseDir)
    const directory = fixture.worktreePaths[1]
    if (!directory) throw new Error("missing member worktree")
    await fixture.git(directory, "switch", "--detach", fixture.next)
    const statePath = path.join(getRuntimeStateDir(fixture.baseDir, fixture.teamRunId), "state.json")
    const before = await readFile(statePath, "utf8")
    const manager = {
      getTasksByParentSession: () => [
        {
          id: "member-task",
          parentSessionId: "lead-session",
          parentMessageId: "create",
          description: "member work",
          prompt: "work",
          agent: "atlas",
          status: "running" as const,
          teamRunId: fixture.teamRunId,
        },
      ],
      cancelTask: mock(async () => true),
    }
    bindNativeTeamWorktrees(manager, fixture.worktrees)

    // when
    const deletion = deleteTeam(fixture.teamRunId, fixture.config, undefined, manager, { force: true })

    // then
    await expect(deletion).rejects.toThrow("member-b")
    expect(await readFile(statePath, "utf8")).toBe(before)
    expect(manager.cancelTask).not.toHaveBeenCalled()
    expect(fixture.removals).toEqual([])
    await Promise.all(fixture.worktreePaths.map((entry) => access(entry)))
  })

  test("refuses team deletion while non-lead members are still active", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "running",
    })

    // when
    const result = deleteTeam(fixture.teamRunId, fixture.config)

    // then
    await result.then(
      () => {
        throw new Error("expected deleteTeam to reject")
      },
      (error: unknown) => {
        if (!(error instanceof Error)) throw error
        expect(error.message).toBe("members still active")
      },
    )
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    expect(runtimeState.status).toBe("active")
    expect(
      runtimeState.members.filter((member) => member.agentType !== "leader").map((member) => member.status),
    ).toEqual(["running", "running"])
  })

  test("writes shutdown requests to the target inbox and records runtime metadata", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)

    // when
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // then
    const inboxMessages = await readInboxMessages(fixture.teamRunId, "member-a", fixture.config)
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    expect(inboxMessages).toHaveLength(1)
    expect(inboxMessages[0]).toEqual(
      expect.objectContaining({
        from: "lead",
        to: "member-a",
        kind: "shutdown_request",
        body: "",
      }),
    )
    expect(runtimeState.shutdownRequests).toEqual([
      expect.objectContaining({
        memberId: "member-a",
        requesterName: "lead",
        requestedAt: expect.any(Number),
      }),
    ])
  })

  test("approves shutdown requests and notifies the lead", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // when
    await approveShutdown(fixture.teamRunId, "member-a", "member-a", fixture.config)

    // then
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    const leadInboxMessages = await readInboxMessages(fixture.teamRunId, "lead", fixture.config)
    const approvedRequest = runtimeState.shutdownRequests.find(
      (shutdownRequest) => shutdownRequest.memberId === "member-a",
    )
    expect(approvedRequest?.approvedAt).toEqual(expect.any(Number))
    expect(runtimeState.members.find((member) => member.name === "member-a")?.status).toBe("shutdown_approved")
    expect(
      leadInboxMessages.some(
        (message) =>
          message.kind === "shutdown_approved" &&
          message.from === "member-a" &&
          message.to === "lead" &&
          message.body === "member-a",
      ),
    ).toBe(true)
  })

  test("rejects shutdown requests and replies to the original requester", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // when
    await rejectShutdown(fixture.teamRunId, "member-a", "member-a", "not done yet", fixture.config)

    // then
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    const leadInboxMessages = await readInboxMessages(fixture.teamRunId, "lead", fixture.config)
    const rejectedRequest = runtimeState.shutdownRequests.find(
      (shutdownRequest) => shutdownRequest.memberId === "member-a",
    )
    expect(rejectedRequest).toEqual(
      expect.objectContaining({
        rejectedAt: expect.any(Number),
        rejectedReason: "not done yet",
      }),
    )
    expect(
      leadInboxMessages.some(
        (message) =>
          message.kind === "shutdown_rejected" &&
          message.from === "member-a" &&
          message.to === "lead" &&
          message.body === "not done yet",
      ),
    ).toBe(true)
  })

  test("rejects shutdown requests from a lead caller as the lead member", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "member-b", fixture.config)

    // when
    await rejectShutdown(fixture.teamRunId, "member-a", "lead", "still needed", fixture.config)

    // then
    const requesterInboxMessages = await readInboxMessages(fixture.teamRunId, "member-b", fixture.config)
    expect(
      requesterInboxMessages.some(
        (message) =>
          message.kind === "shutdown_rejected" &&
          message.from === "lead" &&
          message.to === "member-b" &&
          message.body === "still needed",
      ),
    ).toBe(true)
  })

  test("deletes team runtime resources after all non-lead members are approved", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await mkdir(worktreePath, { recursive: true })
      }),
    )
    // when
    const result = await deleteTeam(fixture.teamRunId, fixture.config)

    // then
    expect(result.removedLayout).toBe(false)
    expect(result.removedWorktrees.sort()).toEqual([...fixture.worktreePaths].sort())
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await access(worktreePath).then(
          () => {
            throw new Error(`expected ${worktreePath} to be removed`)
          },
          () => undefined,
        )
      }),
    )
    const runtimeStateDirectory = getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    await access(runtimeStateDirectory).then(
      () => {
        throw new Error(`expected ${runtimeStateDirectory} to be removed`)
      },
      () => undefined,
    )
  })

  test("#given a team run is tracked for session cleanup #when deleteTeam succeeds #then it unregisters the run", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    registerTeamRunForSessionCleanup(fixture.teamRunId)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })

    // when
    await deleteTeam(fixture.teamRunId, fixture.config)

    // then
    expect(getSessionCreatedTeamRunIds()).toEqual([])
  })

  test("deletes team even with active members when force=true", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "running",
    })
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await mkdir(worktreePath, { recursive: true })
      }),
    )

    // when
    const result = await deleteTeam(fixture.teamRunId, fixture.config, undefined, undefined, { force: true })

    // then
    expect(result.removedLayout).toBe(false)
    expect(result.removedWorktrees.sort()).toEqual([...fixture.worktreePaths].sort())
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await access(worktreePath).then(
          () => {
            throw new Error(`expected ${worktreePath} to be removed`)
          },
          () => undefined,
        )
      }),
    )
    const runtimeStateDirectory = getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    await access(runtimeStateDirectory).then(
      () => {
        throw new Error(`expected ${runtimeStateDirectory} to be removed`)
      },
      () => undefined,
    )
  })

  test("force deletes a team stuck in 'creating' status", async () => {
    // given
    const fixture = await createFixture({ status: "creating" })
    temporaryDirectories.push(fixture.baseDir)
    const transitionedStatuses: string[] = []
    const originalTransitionRuntimeState = runtimeStateStore.transitionRuntimeState
    spyOn(runtimeStateStore, "transitionRuntimeState").mockImplementation(async (teamRunId, transition, config) => {
      const currentRuntimeState = await runtimeStateStore.loadRuntimeState(teamRunId, config)
      transitionedStatuses.push(transition(currentRuntimeState).status)
      return await originalTransitionRuntimeState(teamRunId, transition, config)
    })
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "pending",
      "member-b": "pending",
    })

    // when
    await deleteTeam(fixture.teamRunId, fixture.config, undefined, undefined, { force: true })

    // then
    expect(transitionedStatuses).toContain("deleted")
    const runtimeStateDirectory = getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    await access(runtimeStateDirectory).then(
      () => {
        throw new Error(`expected ${runtimeStateDirectory} to be removed`)
      },
      () => undefined,
    )
  })

  test("force deletes a team in 'orphaned' status", async () => {
    // given
    const fixture = await createFixture({ status: "orphaned" })
    temporaryDirectories.push(fixture.baseDir)
    const transitionedStatuses: string[] = []
    const originalTransitionRuntimeState = runtimeStateStore.transitionRuntimeState
    spyOn(runtimeStateStore, "transitionRuntimeState").mockImplementation(async (teamRunId, transition, config) => {
      const currentRuntimeState = await runtimeStateStore.loadRuntimeState(teamRunId, config)
      transitionedStatuses.push(transition(currentRuntimeState).status)
      return await originalTransitionRuntimeState(teamRunId, transition, config)
    })
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "running",
    })

    // when
    await deleteTeam(fixture.teamRunId, fixture.config, undefined, undefined, { force: true })

    // then
    expect(transitionedStatuses).toContain("deleted")
    const runtimeStateDirectory = getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    await access(runtimeStateDirectory).then(
      () => {
        throw new Error(`expected ${runtimeStateDirectory} to be removed`)
      },
      () => undefined,
    )
  })

  test("force removes lead member worktree if present", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    const leadWorktreePath = path.join(fixture.baseDir, "fixture-worktrees", "lead")
    await transitionRuntimeState(
      fixture.teamRunId,
      (runtimeState) => ({
        ...runtimeState,
        members: runtimeState.members.map((member) =>
          member.name === "lead" ? { ...member, worktreePath: leadWorktreePath } : member,
        ),
      }),
      fixture.config,
    )
    await mkdir(leadWorktreePath, { recursive: true })
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await mkdir(worktreePath, { recursive: true })
      }),
    )
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "running",
    })

    // when
    const result = await deleteTeam(fixture.teamRunId, fixture.config, undefined, undefined, { force: true })

    // then
    expect(result.removedWorktrees.sort()).toEqual([leadWorktreePath, ...fixture.worktreePaths].sort())
    await access(leadWorktreePath).then(
      () => {
        throw new Error(`expected ${leadWorktreePath} to be removed`)
      },
      () => undefined,
    )
  })

  test("force continues cleanup when removeTeamLayout throws", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    const transitionedStatuses: string[] = []
    const originalTransitionRuntimeState = runtimeStateStore.transitionRuntimeState
    spyOn(runtimeStateStore, "transitionRuntimeState").mockImplementation(async (teamRunId, transition, config) => {
      const currentRuntimeState = await runtimeStateStore.loadRuntimeState(teamRunId, config)
      transitionedStatuses.push(transition(currentRuntimeState).status)
      return await originalTransitionRuntimeState(teamRunId, transition, config)
    })
    const logMock = mock(() => {})
    const deps = {
      canVisualize: () => true,
      removeTeamLayout: async () => {
        throw new Error("layout failed")
      },
      log: logMock,
    } satisfies DeleteTeamDeps
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "idle",
    })
    await Promise.all(
      fixture.worktreePaths.map(async (worktreePath) => {
        await mkdir(worktreePath, { recursive: true })
      }),
    )

    // when
    const result = await deleteTeam(
      fixture.teamRunId,
      { ...fixture.config, tmux_visualization: true },
      { getServerUrl: () => "http://localhost" } as never,
      undefined,
      { force: true },
      deps,
    )

    // then
    expect(result.removedLayout).toBe(true)
    expect(transitionedStatuses).toContain("deleted")
    expect(logMock).toHaveBeenCalledWith("team delete layout cleanup failed", {
      teamRunId: fixture.teamRunId,
      error: "layout failed",
    })
    const runtimeStateDirectory = getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    await access(runtimeStateDirectory).then(
      () => {
        throw new Error(`expected ${runtimeStateDirectory} to be removed`)
      },
      () => undefined,
    )
  })

  test("#given tmux manager but visualization disabled #when deleteTeam runs #then layout cleanup is skipped", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    const removeLayoutMock = mock(async () => {})
    const deps = {
      canVisualize: () => true,
      removeTeamLayout: removeLayoutMock,
      log: () => {},
    } satisfies DeleteTeamDeps
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "completed",
    })

    // when
    const result = await deleteTeam(
      fixture.teamRunId,
      { ...fixture.config, tmux_visualization: false },
      { getServerUrl: () => "http://localhost" } as never,
      undefined,
      undefined,
      deps,
    )

    // then
    expect(result.removedLayout).toBe(false)
    expect(removeLayoutMock).not.toHaveBeenCalled()
  })

  test("cancels team background tasks before deleting when force=true", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "idle",
    })
    const runtimeStatusesDuringCancellation: Array<{ teamStatus: string; memberStatuses: string[] }> = []
    const cancelTaskMock = mock(async () => {
      const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
      runtimeStatusesDuringCancellation.push({
        teamStatus: runtimeState.status,
        memberStatuses: runtimeState.members
          .filter((member) => member.agentType !== "leader")
          .map((member) => member.status),
      })
      return true
    })
    const bgMgr = {
      getTasksByParentSession: () => [
        { id: "team-task-a", sessionId: "session-a", parentMessageId: `team-create:${fixture.teamRunId}:member-a` },
        { id: "team-task-b", sessionId: "session-b", parentMessageId: `team-create:${fixture.teamRunId}:member-b` },
      ],
      cancelTask: cancelTaskMock,
    }

    // when
    await deleteTeam(fixture.teamRunId, fixture.config, undefined, bgMgr as never, { force: true })

    // then
    expect(cancelTaskMock).toHaveBeenCalledTimes(2)
    expect(runtimeStatusesDuringCancellation).toEqual([
      { teamStatus: "active", memberStatuses: ["running", "idle"] },
      { teamStatus: "active", memberStatuses: ["running", "idle"] },
    ])
  })

  test("blocks mailbox writes while the team is deleting", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })
    await transitionRuntimeState(
      fixture.teamRunId,
      (runtimeState) => ({
        ...runtimeState,
        status: "deleting",
      }),
      fixture.config,
    )

    // when
    const result = sendMessage(createTestMessage(), fixture.teamRunId, fixture.config, {
      isLead: true,
      activeMembers: ["lead", "member-a", "member-b"],
    })

    // then
    await result.then(
      () => {
        throw new Error("expected sendMessage to reject")
      },
      (error: unknown) => {
        if (!(error instanceof Error)) throw error
        expect(error.message).toBe("team is deleting")
      },
    )
  })
})

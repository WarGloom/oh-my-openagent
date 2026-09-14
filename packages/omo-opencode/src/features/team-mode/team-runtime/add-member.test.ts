/// <reference types="bun-types" />

// allow: SIZE_OK - team add-member tests share filesystem/background-manager mock state; cases cover admission, preservation, rollback, and concurrency for one feature.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundTask, LaunchInput } from "../../background-agent/types"
import { BackgroundManager } from "../../background-agent/manager"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { clearTeamSessionRegistry, lookupTeamSession } from "../team-session-registry"
import type { Member, TeamSpec } from "../types"

const resolveMemberMock = mock(async (member: TeamSpec["members"][number]) => ({
  agentToUse: `${member.name}-agent`,
  model: { providerID: "openai", modelID: "gpt-5.6-luna-fast" },
  fallbackChain: undefined,
  systemContent: `system:${member.name}`,
}))

mock.module("./resolve-member", () => ({ resolveMember: resolveMemberMock }))

const { createTeamRun } = await import("./create")
const { addTeamMember, TeamAddMemberError } = await import("./add-member")

function createConfig(baseDir: string, overrides: Record<string, unknown> = {}) {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, max_wall_clock_minutes: 1, ...overrides })
}

function inlineMember(name: string): Member {
  return { kind: "category", name, category: "quick", prompt: `prompt-${name}`, backendType: "in-process", isActive: true } as Member
}

function createSpec(names: string[]): TeamSpec {
  return {
    version: 1,
    name: "alpha-team",
    createdAt: Date.now(),
    leadAgentId: names[0],
    members: names.map((name) => ({
      kind: "category",
      name,
      category: "quick",
      prompt: `prompt-${name}`,
      backendType: "in-process",
      isActive: true,
    })),
  } as TeamSpec
}

function createContext(baseDir: string, manager: BackgroundManager): ExecutorContext {
  return {
    client: {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        create: mock(async () => ({ data: { id: "forbidden" } })),
        abort: async () => undefined,
        get: async () => ({}),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    },
    manager,
    directory: baseDir,
  }
}

function createManager(
  baseDir: string,
  launchImpl: (input: LaunchInput) => Promise<BackgroundTask>,
  getTaskImpl: (taskId: string) => BackgroundTask | undefined = () => undefined,
): { manager: BackgroundManager; launchMock: ReturnType<typeof mock>; cancelTaskMock: ReturnType<typeof mock> } {
  const manager = new BackgroundManager({ pluginContext: { client: {} as ExecutorContext["client"], directory: baseDir } as PluginInput })
  const launchMock = mock((input: LaunchInput) => launchImpl(input))
  const getTaskMock = mock((taskId: string) => getTaskImpl(taskId))
  const cancelTaskMock = mock(async () => true)
  manager.launch = launchMock as unknown as BackgroundManager["launch"]
  manager.getTask = getTaskMock as unknown as BackgroundManager["getTask"]
  manager.cancelTask = cancelTaskMock as unknown as BackgroundManager["cancelTask"]
  return { manager, launchMock, cancelTaskMock }
}

function runningLaunch(): (input: LaunchInput) => Promise<BackgroundTask> {
  return async (input) => ({ id: `task-${input.description}`, sessionId: `session-${input.description}`, status: "running" } as BackgroundTask)
}

describe("addTeamMember", () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    resolveMemberMock.mockClear()
    clearTeamSessionRegistry()
  })

  afterAll(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => rm(directoryPath, { recursive: true, force: true })))
  })

  test("corrective: rollback preserves a pre-existing worktree and releases an inbox acquisition failure", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-owned-"))
    temporaryDirectories.push(baseDir)
    const { manager } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir)
    const runtime = await createTeamRun(createSpec(["lead"]), "lead-session", createContext(baseDir, manager), config, manager)
    const worktreePath = path.join(baseDir, "existing")
    await mkdir(worktreePath)
    await writeFile(path.join(worktreePath, "keep"), "original")
    manager.launch = async () => { throw new Error("spawn failed") }
    const input = { teamRunId: runtime.teamRunId, member: { ...inlineMember("new"), worktreePath }, leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager }
    // when / then
    await expect(addTeamMember(input)).rejects.toThrow("spawn failed")
    expect(await readFile(path.join(worktreePath, "keep"), "utf8")).toBe("original")
    const inbox = getInboxDir(resolveBaseDir(config), runtime.teamRunId, "blocked")
    await mkdir(path.dirname(inbox), { recursive: true })
    await writeFile(inbox, "not a directory")
    await expect(addTeamMember({ ...input, member: inlineMember("blocked") })).rejects.toThrow()
    expect((await loadRuntimeState(runtime.teamRunId, config)).members.map((m) => m.name)).toEqual(["lead"])
  })

  test("corrective: lost claim prevents callback publication before launch returns", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-claim-"))
    temporaryDirectories.push(baseDir)
    const { manager } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir)
    const runtime = await createTeamRun(createSpec(["lead"]), "lead-session", createContext(baseDir, manager), config, manager)
    manager.launch = async (input) => {
      await transitionRuntimeState(runtime.teamRunId, (state) => ({ ...state, status: "deleting" }), config)
      await input.onSessionCreated?.("late-session")
      expect(lookupTeamSession("late-session")).toBeUndefined()
      throw new Error("callback should have refused publication")
    }
    // when / then
    await expect(addTeamMember({ teamRunId: runtime.teamRunId, member: inlineMember("new"), leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager })).rejects.toThrow("ownership lost")
    expect(lookupTeamSession("late-session")).toBeUndefined()
  })

  test("corrective: finalization retains known error and reconciled shutdown", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-terminal-"))
    temporaryDirectories.push(baseDir)
    const { manager } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir)
    const runtime = await createTeamRun(createSpec(["lead"]), "lead-session", createContext(baseDir, manager), config, manager)
    manager.launch = async (input) => {
      const sessionId = `session-${input.description}`
      await input.onSessionCreated?.(sessionId)
      if (input.description.startsWith("shutdown")) {
        await transitionRuntimeState(runtime.teamRunId, (state) => ({ ...state, members: state.members.map((m) => m.sessionId === sessionId ? { ...m, status: "shutdown_approved" } : m) }), config)
      }
      const status = input.description.startsWith("success") ? "completed" : input.description.startsWith("cancel") ? "cancelled" : "error"
      return { id: input.description, sessionId, status, teamRunId: runtime.teamRunId } as BackgroundTask
    }
    const input = { teamRunId: runtime.teamRunId, leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager }
    // when / then
    expect((await addTeamMember({ ...input, member: inlineMember("failed") })).status).toBe("errored")
    expect((await addTeamMember({ ...input, member: inlineMember("shutdown") })).status).toBe("shutdown_approved")
    expect((await addTeamMember({ ...input, member: inlineMember("success") })).status).toBe("running")
    expect((await addTeamMember({ ...input, member: inlineMember("cancel") })).status).toBe("running")
  })

  test("corrective: rollback retains ownership unless current task state proves cancellation stopped it", async () => {
    // given
    for (const outcome of ["false-running", "throw-running", "false-terminal"] as const) {
      const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-stop-proof-"))
      temporaryDirectories.push(baseDir)
      const { manager } = createManager(baseDir, runningLaunch())
      const config = createConfig(baseDir, { max_members: 2 })
      const runtime = await createTeamRun(createSpec(["lead"]), "lead-session", createContext(baseDir, manager), config, manager)
      const task = { id: "added-task", sessionId: "added-session", status: "running" } as BackgroundTask
      manager.launch = async (input) => {
        await input.onSessionCreated?.(task.sessionId!)
        return task
      }
      let reads = 0
      manager.getTask = () => {
        if (++reads === 2) throw new Error("finalization failed")
        return task
      }
      manager.cancelTask = async () => {
        if (outcome === "throw-running") throw new Error("abort failed")
        if (outcome === "false-terminal") task.status = "completed"
        return false
      }
      const worktreePath = path.join(baseDir, "added-worktree")
      const input = { teamRunId: runtime.teamRunId, member: { ...inlineMember("new"), worktreePath }, leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager }

      // when / then
      await expect(addTeamMember(input)).rejects.toThrow(outcome === "false-terminal" ? "finalization failed" : "rollback incomplete")
      const added = (await loadRuntimeState(runtime.teamRunId, config)).members.find((member) => member.name === "new")
      const inbox = getInboxDir(resolveBaseDir(config), runtime.teamRunId, "new")
      if (outcome === "false-terminal") {
        expect(added).toBeUndefined()
        expect(lookupTeamSession(task.sessionId!)).toBeUndefined()
        await expect(access(worktreePath)).rejects.toThrow()
        await expect(access(inbox)).rejects.toThrow()
      } else {
        expect(added?.provisioningClaimId).toBeDefined()
        expect(lookupTeamSession(task.sessionId!)).toMatchObject({ memberName: "new" })
        await access(worktreePath)
        await access(inbox)
        await expect(addTeamMember({ ...input, member: inlineMember("other") })).rejects.toThrow(/at capacity/)
      }
    }
  })

  test("#given an active run #when a member is added #then existing members, tasks, and mailboxes are preserved and the new member is addressable", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-preserve-"))
    temporaryDirectories.push(baseDir)
    const { manager } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir, { max_members: 8 })
    const runtime = await createTeamRun(createSpec(["lead", "worker-a"]), "lead-session", createContext(baseDir, manager), config, manager)
    const existingInbox = path.join(getInboxDir(resolveBaseDir(config), runtime.teamRunId, "worker-a"), "keep.json")
    await writeFile(existingInbox, "{\"kept\":true}")
    const before = await loadRuntimeState(runtime.teamRunId, config)

    // when
    const result = await addTeamMember({
      teamRunId: runtime.teamRunId,
      member: inlineMember("worker-b"),
      leadSessionId: "lead-session",
      ctx: createContext(baseDir, manager),
      config,
      bgMgr: manager,
    })

    // then
    expect(result).toMatchObject({ teamRunId: runtime.teamRunId, memberName: "worker-b", status: "running" })
    expect(result.sessionId).toBe("session-worker-b: prompt-worker-b")
    const after = await loadRuntimeState(runtime.teamRunId, config)
    expect(after.members.map((member) => member.name)).toEqual(["lead", "worker-a", "worker-b"])
    expect(after.members.find((member) => member.name === "worker-a")).toEqual(before.members.find((member) => member.name === "worker-a"))
    expect(after.members.find((member) => member.name === "lead")).toEqual(before.members.find((member) => member.name === "lead"))
    expect(JSON.parse(await readFile(existingInbox, "utf8"))).toEqual({ kept: true })
    expect(after.members.find((member) => member.name === "worker-b")?.provisioningClaimId).toBeUndefined()
    expect(lookupTeamSession(result.sessionId)).toMatchObject({ teamRunId: runtime.teamRunId, memberName: "worker-b", role: "member" })
  })

  test.each([8, 16])("#given roster cap %i #when creating and extending a run #then the lead counts and overflow never provisions", async (cap) => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-roster-boundary-"))
    temporaryDirectories.push(baseDir)
    const { manager, launchMock } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir, { max_members: cap })
    const ctx = createContext(baseDir, manager)
    const names = ["lead", ...Array.from({ length: cap - 1 }, (_, index) => `worker-${index}`)]

    const full = await createTeamRun(createSpec(names), "full-lead-session", ctx, config, manager)
    expect(full.members).toHaveLength(cap)
    expect(full.members.filter((member) => member.agentType === "leader")).toHaveLength(1)
    expect(full.bounds).toMatchObject({ maxMembers: cap, maxParallelMembers: 4 })
    const launchesAtCapacity = launchMock.mock.calls.length
    await expect(createTeamRun(createSpec([...names, "overflow"]), "overflow-session", ctx, config, manager)).rejects.toThrow(`max_members cap is ${cap}`)
    expect(launchMock.mock.calls.length).toBe(launchesAtCapacity)

    const runtime = await createTeamRun(createSpec(names.slice(0, -1)), "growing-lead-session", ctx, config, manager)
    const input = { teamRunId: runtime.teamRunId, leadSessionId: "growing-lead-session", ctx, config, bgMgr: manager }
    await addTeamMember({ ...input, member: inlineMember("last-worker") })
    const filled = await loadRuntimeState(runtime.teamRunId, config)
    expect(filled.members).toHaveLength(cap)
    const launchesAfterAdd = launchMock.mock.calls.length
    await expect(addTeamMember({ ...input, config: createConfig(baseDir, { max_members: 16 }), member: inlineMember("overflow") })).rejects.toThrow(`at capacity (${cap}/${cap}`)
    expect(launchMock.mock.calls.length).toBe(launchesAfterAdd)
    expect((await loadRuntimeState(runtime.teamRunId, config)).members).toEqual(filled.members)
  })

  test("#given a run at capacity #when a member is added #then it is rejected with an informative error and no reserved row remains", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-capacity-"))
    temporaryDirectories.push(baseDir)
    const { manager, launchMock } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir, { max_members: 2 })
    const runtime = await createTeamRun(createSpec(["lead", "worker-a"]), "lead-session", createContext(baseDir, manager), config, manager)
    const launchesAfterCreate = launchMock.mock.calls.length

    // when / then
    await expect(addTeamMember({
      teamRunId: runtime.teamRunId,
      member: inlineMember("worker-b"),
      leadSessionId: "lead-session",
      ctx: createContext(baseDir, manager),
      config,
      bgMgr: manager,
    })).rejects.toThrow(/at capacity \(2\/2/)
    const after = await loadRuntimeState(runtime.teamRunId, config)
    expect(after.members.map((member) => member.name)).toEqual(["lead", "worker-a"])
    expect(launchMock.mock.calls.length).toBe(launchesAfterCreate)
  })

  test("#given a member spawn that fails after launch #when the add rolls back #then only the added member's task is cancelled and the run stays active", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-rollback-"))
    temporaryDirectories.push(baseDir)
    const failingTaskId = "task-worker-b: prompt-worker-b"
    const { manager, cancelTaskMock } = createManager(
      baseDir,
      async (input) => {
        if (input.description.startsWith("worker-b")) {
          return { id: `task-${input.description}`, status: "error", error: "worker-b spawn failed" } as BackgroundTask
        }
        return { id: `task-${input.description}`, sessionId: `session-${input.description}`, status: "running" } as BackgroundTask
      },
      (taskId) => (taskId === failingTaskId ? { id: taskId, status: "error", error: "worker-b spawn failed" } as BackgroundTask : undefined),
    )
    const config = createConfig(baseDir, { max_members: 8 })
    const runtime = await createTeamRun(createSpec(["lead", "worker-a"]), "lead-session", createContext(baseDir, manager), config, manager)

    // when / then
    await expect(addTeamMember({
      teamRunId: runtime.teamRunId,
      member: inlineMember("worker-b"),
      leadSessionId: "lead-session",
      ctx: createContext(baseDir, manager),
      config,
      bgMgr: manager,
    })).rejects.toBeInstanceOf(TeamAddMemberError)
    expect((cancelTaskMock.mock.calls as Array<[string]>).map(([taskId]) => taskId)).toEqual([failingTaskId])
    const after = await loadRuntimeState(runtime.teamRunId, config)
    expect(after.members.map((member) => member.name)).toEqual(["lead", "worker-a"])
    expect(after.status).toBe("active")
  })

  test("#given two concurrent adds for the last slot #when both run #then exactly one wins and the other gets an informative capacity error", async () => {
    // given
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-add-concurrent-"))
    temporaryDirectories.push(baseDir)
    const { manager } = createManager(baseDir, runningLaunch())
    const config = createConfig(baseDir, { max_members: 3 })
    const runtime = await createTeamRun(createSpec(["lead", "worker-a"]), "lead-session", createContext(baseDir, manager), config, manager)

    // when
    const settled = await Promise.allSettled([
      addTeamMember({ teamRunId: runtime.teamRunId, member: inlineMember("worker-b"), leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager }),
      addTeamMember({ teamRunId: runtime.teamRunId, member: inlineMember("worker-c"), leadSessionId: "lead-session", ctx: createContext(baseDir, manager), config, bgMgr: manager }),
    ])

    // then
    const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled")
    const rejected = settled.filter((outcome) => outcome.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/at capacity/)
    const after = await loadRuntimeState(runtime.teamRunId, config)
    expect(after.members).toHaveLength(3)
  })
})

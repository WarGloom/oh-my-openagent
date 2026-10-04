/// <reference types="bun-types" />
import { expect, spyOn, test } from "bun:test"
import { saveRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import * as locks from "../team-state-store/locks"
import { getTaskClaimLockPath, getTaskFilePath, resolveBaseDir } from "../team-registry"
import { RuntimeStateSchema } from "../types"
import { claimTask } from "./claim"
import { getTask } from "./get"
import { createTask } from "./store"
import { createTaskInput, createTasklistFixture } from "./test-support"
import { updateTaskStatus } from "./update"
import { requeueMemberTasks } from "./requeue"

async function fixture() {
  const f = await createTasklistFixture()
  const removal = {
    operationId: crypto.randomUUID(),
    sessionId: "worker-session",
    startedAt: 1,
    phase: "stopped" as const,
    taskIds: [],
  }
  const state = RuntimeStateSchema.parse({
    version: 1,
    teamRunId: f.teamRunId,
    teamName: "alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    shutdownRequests: [],
    bounds: {
      maxMembers: 2,
      maxParallelMembers: 2,
      maxMessagesPerRun: 100,
      maxWallClockMinutes: 120,
      maxMemberTurns: 100,
    },
    members: [
      { name: "lead", sessionId: "lead-session", agentType: "leader", status: "running", removalProtocolVersion: 1 },
      { name: "worker", sessionId: "worker-session", agentType: "general-purpose", status: "running", removal },
    ],
  })
  await saveRuntimeState(state, f.config)
  return { ...f, removal, memberName: "worker" }
}

test.each(["claimed", "in_progress"] as const)(
  "requeue preserves partial work when owned task is %s",
  async (status) => {
    // given
    const f = await fixture()
    try {
      const task = await createTask(
        f.teamRunId,
        createTaskInput({
          status,
          owner: "worker",
          claimedAt: 7,
          activeForm: "building",
          blocks: ["9"],
          blockedBy: ["8"],
          metadata: { progress: { file: "partial.ts" } },
        }),
        f.config,
      )
      // when
      const ids = await requeueMemberTasks(f)
      const loaded = await getTask(f.teamRunId, task.id, f.config)
      // then
      expect(ids).toEqual([task.id])
      expect(loaded).toMatchObject({
        subject: task.subject,
        description: task.description,
        activeForm: "building",
        status: "pending",
        blocks: ["9"],
        blockedBy: ["8"],
        createdAt: task.createdAt,
        metadata: {
          progress: { file: "partial.ts" },
          "omo.team-member-removal": {
            hold: f.removal.operationId,
            audits: {
              [f.removal.operationId]: { priorOwner: "worker", priorStatus: status, priorClaimedAt: 7 },
            },
          },
        },
      })
      expect(loaded.owner).toBeUndefined()
      expect(loaded.claimedAt).toBeUndefined()
      await expect(claimTask(f.teamRunId, task.id, "fresh", f.config)).rejects.toThrow()
    } finally {
      await f.cleanup()
    }
  },
)

test("requeue leaves terminal, other-owned and unowned pending task bytes unchanged", async () => {
  // given
  const f = await fixture()
  try {
    const tasks = await Promise.all(
      [
        createTaskInput({ status: "completed", owner: "worker" }),
        createTaskInput({ status: "deleted", owner: "worker" }),
        createTaskInput({ status: "claimed", owner: "other" }),
        createTaskInput(),
      ].map((input) => createTask(f.teamRunId, input, f.config)),
    )
    // when
    expect(await requeueMemberTasks(f)).toEqual([])
    // then
    expect(await Promise.all(tasks.map((task) => getTask(f.teamRunId, task.id, f.config)))).toEqual(tasks)
    await expect(claimTask(f.teamRunId, tasks[3]?.id ?? "missing", "worker", f.config)).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
})

test("requeue reconciles a partial write without duplicating audit on retry", async () => {
  // given
  const f = await fixture()
  const write = locks.atomicWrite
  const tasks = [
    await createTask(f.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), f.config),
    await createTask(f.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), f.config),
  ]
  const second = tasks[1]
  if (!second) throw new Error("second task missing")
  const faultPath = getTaskFilePath(resolveBaseDir(f.config), f.teamRunId, second.id)
  const fault = spyOn(locks, "atomicWrite").mockImplementation(async (p, content, deps) => {
    if (p === faultPath) throw new Error("controlled task write failure")
    return write(p, content, deps)
  })
  try {
    // when
    await expect(requeueMemberTasks(f)).rejects.toThrow("controlled task write failure")
    const first = await getTask(f.teamRunId, tasks[0]?.id ?? "missing", f.config)
    expect(first.status).toBe("pending")
    fault.mockRestore()
    const ids = await requeueMemberTasks(f)
    // then
    expect(ids).toEqual(tasks.map((t) => t.id))
    expect(await getTask(f.teamRunId, first.id, f.config)).toEqual(first)
  } finally {
    fault.mockRestore()
    await f.cleanup()
  }
})

test("update rechecks the removal fence after waiting for the task lock", async () => {
  // given
  const f = await fixture()
  try {
    await transitionRuntimeState(
      f.teamRunId,
      (state) => ({ ...state, members: state.members.map((m) => ({ ...m, removal: undefined })) }),
      f.config,
    )
    const task = await createTask(f.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), f.config)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const lock = locks.withLock(getTaskClaimLockPath(resolveBaseDir(f.config), f.teamRunId, task.id), async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const update = updateTaskStatus(f.teamRunId, task.id, "in_progress", "worker", f.config).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    // when
    await transitionRuntimeState(
      f.teamRunId,
      (state) => ({
        ...state,
        members: state.members.map((m) => (m.name === "worker" ? { ...m, removal: f.removal } : m)),
      }),
      f.config,
    )
    release.resolve()
    await lock
    // then
    expect(await update).toHaveProperty("error")
    expect((await getTask(f.teamRunId, task.id, f.config)).status).toBe("claimed")
  } finally {
    await f.cleanup()
  }
}, 5000)

test("requeue waits for an admitted update and preserves its completed work", async () => {
  // given
  const f = await fixture()
  const write = locks.atomicWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await transitionRuntimeState(
    f.teamRunId,
    (state) => ({ ...state, members: state.members.map((m) => ({ ...m, removal: undefined })) }),
    f.config,
  )
  const task = await createTask(f.teamRunId, createTaskInput({ status: "in_progress", owner: "worker" }), f.config)
  const taskPath = getTaskFilePath(resolveBaseDir(f.config), f.teamRunId, task.id)
  const barrier = spyOn(locks, "atomicWrite").mockImplementation(async (p, content, deps) => {
    if (p === taskPath) {
      entered.resolve()
      await release.promise
    }
    return write(p, content, deps)
  })
  try {
    const update = updateTaskStatus(f.teamRunId, task.id, "completed", "worker", f.config)
    await entered.promise
    await transitionRuntimeState(
      f.teamRunId,
      (state) => ({
        ...state,
        members: state.members.map((m) => (m.name === "worker" ? { ...m, removal: f.removal } : m)),
      }),
      f.config,
    )
    // when
    const requeue = requeueMemberTasks(f)
    release.resolve()
    await update
    // then
    expect(await requeue).toEqual([])
    expect((await getTask(f.teamRunId, task.id, f.config)).status).toBe("completed")
  } finally {
    release.resolve()
    barrier.mockRestore()
    await f.cleanup()
  }
}, 5000)

test("requeue waits for an admitted claim before clearing the old ownership", async () => {
  // given
  const f = await fixture()
  const write = locks.atomicWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await transitionRuntimeState(
    f.teamRunId,
    (state) => ({ ...state, members: state.members.map((m) => ({ ...m, removal: undefined })) }),
    f.config,
  )
  const task = await createTask(f.teamRunId, createTaskInput(), f.config)
  const taskPath = getTaskFilePath(resolveBaseDir(f.config), f.teamRunId, task.id)
  const barrier = spyOn(locks, "atomicWrite").mockImplementation(async (p, content, deps) => {
    if (p === taskPath && JSON.parse(String(content)).status === "claimed") {
      entered.resolve()
      await release.promise
    }
    return write(p, content, deps)
  })
  try {
    const claim = claimTask(f.teamRunId, task.id, "worker", f.config)
    await entered.promise
    await transitionRuntimeState(
      f.teamRunId,
      (state) => ({
        ...state,
        members: state.members.map((m) => (m.name === "worker" ? { ...m, removal: f.removal } : m)),
      }),
      f.config,
    )
    // when
    const requeue = requeueMemberTasks(f)
    release.resolve()
    await claim
    // then
    expect(await requeue).toEqual([task.id])
    expect(await getTask(f.teamRunId, task.id, f.config)).toMatchObject({
      status: "pending",
      metadata: {
        "omo.team-member-removal": {
          audits: { [f.removal.operationId]: { priorOwner: "worker", priorStatus: "claimed" } },
        },
      },
    })
  } finally {
    release.resolve()
    barrier.mockRestore()
    await f.cleanup()
  }
}, 5000)

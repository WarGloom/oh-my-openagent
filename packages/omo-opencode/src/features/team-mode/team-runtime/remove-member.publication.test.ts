/// <reference types="bun-types" />
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { admitAddedMember } from "@oh-my-opencode/team-core/team-state-store/member-admission"
import * as taskLocks from "@oh-my-opencode/team-core/team-state-store/locks"
import { createTask } from "@oh-my-opencode/team-core/team-tasklist/store"
import { createTaskInput } from "@oh-my-opencode/team-core/team-tasklist/test-support"
import { getTask } from "@oh-my-opencode/team-core/team-tasklist/get"
import { claimTask } from "@oh-my-opencode/team-core/team-tasklist/claim"
import { getTaskFilePath, resolveBaseDir } from "@oh-my-opencode/team-core/team-registry"
import { createRemovalTestContext } from "./remove-member.test-support"

const { fixture, cleanup } = createRemovalTestContext()
afterEach(cleanup)

describe("finishTeamMemberRemoval publication", () => {
  test.each(["session", "operation"])("rejects stale %s at publication without releasing the held task", async changed => {
    // given
    const input = await fixture()
    const task = await createTask(input.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), input.config)
    const write = taskLocks.atomicWrite
    const taskPath = getTaskFilePath(resolveBaseDir(input.config), input.teamRunId, task.id)
    const barrier = spyOn(taskLocks, "atomicWrite").mockImplementation(async (p, content, deps) => {
      await write(p, content, deps)
      if (p === taskPath) await transitionRuntimeState(input.teamRunId, s => ({ ...s, members: s.members.map(m => m.name === "worker" && m.removal ? {
        ...m, sessionId: changed === "session" ? "new-session" : m.sessionId,
        removal: { ...m.removal, operationId: changed === "operation" ? crypto.randomUUID() : m.removal.operationId },
      } : m) }), input.config)
    })
    const { finishTeamMemberRemoval } = await import("./remove-member")
    try {
      // when / then
      await expect(finishTeamMemberRemoval({ ...input, bgMgr: { findBySession: () => undefined, getTask: () => undefined, cancelTask: async () => true }, client: { session: { abort: async () => true } } })).rejects.toThrow()
      const state = await loadRuntimeState(input.teamRunId, input.config)
      expect(state.members).toHaveLength(2)
      expect(state.removedMembers).toEqual([])
      await expect(claimTask(input.teamRunId, task.id, "fresh", input.config)).rejects.toThrow()
    } finally { barrier.mockRestore() }
  })
  test("archives the current snapshot once and releases replacement claims only after publication", async () => {
    // given
    const input = await fixture()
    const task = await createTask(input.teamRunId, createTaskInput({ status: "in_progress", owner: "worker", metadata: { partial: "kept" } }), input.config)
    const { finishTeamMemberRemoval } = await import("./remove-member")
    const stop = { ...input, bgMgr: { findBySession: () => undefined, getTask: () => undefined, cancelTask: async () => true },
      client: { session: { abort: async () => {
        await transitionRuntimeState(input.teamRunId, s => ({ ...s, members: s.members.map(m => m.name === "worker" ? { ...m, status: "completed" } : m) }), input.config)
        return true
      } } } }
    // when
    const receipt = await finishTeamMemberRemoval(stop)
    const claimed = await claimTask(input.teamRunId, task.id, "fresh", input.config)
    const retry = await finishTeamMemberRemoval(stop)
    // then
    const state = await loadRuntimeState(input.teamRunId, input.config)
    expect(state.members.map(m => m.name)).toEqual(["lead"])
    expect(state.removedMembers).toEqual([receipt])
    expect(receipt.member.status).toBe("completed")
    expect(receipt.requeuedTaskIds).toEqual([task.id])
    expect(retry).toEqual(receipt)
    expect(await getTask(input.teamRunId, task.id, input.config)).toEqual(claimed)
    await expect(claimTask(input.teamRunId, (await createTask(input.teamRunId, createTaskInput(), input.config)).id, "worker", input.config)).rejects.toThrow()
  })

  test("partial requeue retains capacity and hold, then retries the same operation", async () => {
    // given
    const input = await fixture()
    await transitionRuntimeState(input.teamRunId, s => ({ ...s, bounds: { ...s.bounds, maxMembers: 2 } }), input.config)
    const tasks = [
      await createTask(input.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), input.config),
      await createTask(input.teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), input.config),
    ]
    const second = tasks[1]
    if (!second) throw new Error("second missing")
    const faultPath = getTaskFilePath(resolveBaseDir(input.config), input.teamRunId, second.id)
    const write = taskLocks.atomicWrite
    const fault = spyOn(taskLocks, "atomicWrite").mockImplementation(async (p, content, deps) => {
      if (p === faultPath) throw new Error("partial requeue fault")
      return write(p, content, deps)
    })
    const stop = { ...input, bgMgr: { findBySession: () => undefined, getTask: () => undefined, cancelTask: async () => true }, client: { session: { abort: async () => true } } }
    const { finishTeamMemberRemoval } = await import("./remove-member")
    try {
      // when
      await expect(finishTeamMemberRemoval(stop)).rejects.toThrow()
      const partial = await loadRuntimeState(input.teamRunId, input.config)
      const held = await getTask(input.teamRunId, tasks[0]?.id ?? "missing", input.config)
      // then
      expect(partial.members).toHaveLength(2)
      expect(partial.removedMembers).toEqual([])
      expect(held.status).toBe("pending")
      expect(() => admitAddedMember(partial, "fresh", "claim")).toThrow()
      await expect(claimTask(input.teamRunId, held.id, "fresh", input.config)).rejects.toThrow()
      fault.mockRestore()
      const priorRemoval = partial.members.find(m => m.name === "worker")?.removal
      if (!priorRemoval) throw new Error("partial removal operation missing")
      const receipt = await finishTeamMemberRemoval(stop)
      expect(receipt.operationId).toBe(priorRemoval.operationId)
      expect(receipt.requeuedTaskIds).toEqual(tasks.map(t => t.id))
      expect(await getTask(input.teamRunId, held.id, input.config)).toEqual(held)
      const completed = await loadRuntimeState(input.teamRunId, input.config)
      expect(admitAddedMember(completed, "fresh", "claim").member.name).toBe("fresh")
    } finally { fault.mockRestore() }
  })
})

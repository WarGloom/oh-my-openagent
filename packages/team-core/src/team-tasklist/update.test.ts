/// <reference types="bun-types" />

import { expect, test } from "bun:test"

import { claimTask } from "./claim"
import { getTask } from "./get"
import { createTask } from "./store"
import { createTaskInput, createTasklistFixture } from "./test-support"
import { CrossOwnerUpdateError, InvalidTaskTransitionError, updateTaskStatus } from "./update"

test.each(["in_progress", "deleted", "pending"] as const)(
  "updateTaskStatus rejects held %s mutations even with missing runtime",
  async (status) => {
    // given
    const fixture = await createTasklistFixture()
    try {
      const operationId = crypto.randomUUID()
      const task = await createTask(
        fixture.teamRunId,
        createTaskInput({
          metadata: {
            progress: "partial",
            "omo.team-member-removal": {
              hold: operationId,
              audits: {
                [operationId]: {
                  priorOwner: "member-a",
                  priorStatus: "in_progress",
                  requeuedAt: 2,
                },
              },
            },
          },
        }),
        fixture.config,
      )
      // when / then
      await expect(updateTaskStatus(fixture.teamRunId, task.id, status, "fresh", fixture.config)).rejects.toThrow()
    } finally {
      await fixture.cleanup()
    }
  },
)

test("updateTaskStatus supports the one-way claim to complete flow", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    const task = await createTask(fixture.teamRunId, createTaskInput(), fixture.config)
    await claimTask(fixture.teamRunId, task.id, "member-a", fixture.config)

    // when
    await updateTaskStatus(fixture.teamRunId, task.id, "in_progress", "member-a", fixture.config)
    const completedTask = await updateTaskStatus(fixture.teamRunId, task.id, "completed", "member-a", fixture.config)
    const loadedTask = await getTask(fixture.teamRunId, task.id, fixture.config)

    // then
    expect(completedTask.status).toBe("completed")
    expect(loadedTask.status).toBe("completed")
  } finally {
    await fixture.cleanup()
  }
}, 30_000)

test("updateTaskStatus auto-claims when a member starts a pending task directly", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    const task = await createTask(fixture.teamRunId, createTaskInput(), fixture.config)

    // when
    const inProgressTask = await updateTaskStatus(fixture.teamRunId, task.id, "in_progress", "member-a", fixture.config)
    const loadedTask = await getTask(fixture.teamRunId, task.id, fixture.config)

    // then
    expect(inProgressTask.status).toBe("in_progress")
    expect(inProgressTask.owner).toBe("member-a")
    expect(typeof inProgressTask.claimedAt).toBe("number")
    expect(loadedTask.status).toBe("in_progress")
    expect(loadedTask.owner).toBe("member-a")
    expect(typeof loadedTask.claimedAt).toBe("number")
  } finally {
    await fixture.cleanup()
  }
}, 30_000)

test("updateTaskStatus rejects reverse transitions", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    const task = await createTask(
      fixture.teamRunId,
      createTaskInput({ status: "completed", owner: "member-a", claimedAt: Date.now() }),
      fixture.config,
    )

    // when
    const reversedTransition = updateTaskStatus(fixture.teamRunId, task.id, "claimed", "member-a", fixture.config)

    // then
    await expect(reversedTransition).rejects.toBeInstanceOf(InvalidTaskTransitionError)
    await expect(reversedTransition).rejects.toHaveProperty(
      "message",
      "no reverse transitions from completed to claimed",
    )
  } finally {
    await fixture.cleanup()
  }
})

test("updateTaskStatus rejects non-owner updates except deletion", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    const task = await createTask(
      fixture.teamRunId,
      createTaskInput({ status: "claimed", owner: "member-a", claimedAt: Date.now() }),
      fixture.config,
    )

    // when
    const crossOwnerUpdate = updateTaskStatus(fixture.teamRunId, task.id, "in_progress", "member-b", fixture.config)

    // then
    await expect(crossOwnerUpdate).rejects.toBeInstanceOf(CrossOwnerUpdateError)

    // when
    const deletedTask = await updateTaskStatus(fixture.teamRunId, task.id, "deleted", "lead-member", fixture.config)

    // then
    expect(deletedTask.status).toBe("deleted")
  } finally {
    await fixture.cleanup()
  }
})

test("#given traversal task id #when updating a task #then it rejects before writing outside the task directory", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    // when
    const updatedTask = updateTaskStatus(fixture.teamRunId, "../escape", "completed", "member-a", fixture.config)

    // then
    await expect(updatedTask).rejects.toThrow("team path escapes base directory")
  } finally {
    await fixture.cleanup()
  }
})

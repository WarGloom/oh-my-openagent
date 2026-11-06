/// <reference types="bun-types" />

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../config"
import { getTaskFilePath, getTasksDir, resolveBaseDir } from "../team-registry"
import { subscribeTeamRuntimeChanges } from "../team-state-store/changes"
import { TaskSchema } from "../types"
import type { Task } from "../types"
import { AlreadyClaimedError, claimTask } from "./claim"
import { createTask } from "./store"
import { createTaskInput, createTasklistFixture } from "./test-support"
import { updateTaskStatus } from "./update"

test("createTask assigns distinct ids during concurrent creation", async () => {
  // given
  const fixture = await createTasklistFixture()

  try {
    // when
    const [firstTask, secondTask] = await Promise.all([
      createTask(fixture.teamRunId, createTaskInput({ subject: "first task" }), fixture.config),
      createTask(fixture.teamRunId, createTaskInput({ subject: "second task" }), fixture.config),
    ])

    const tasksDirectory = getTasksDir(resolveBaseDir(fixture.config), fixture.teamRunId)
    const watermarkContent = await readFile(path.join(tasksDirectory, ".highwatermark"), "utf8")
    const sortedIds = [firstTask.id, secondTask.id].sort((leftId, rightId) => Number(leftId) - Number(rightId))

    // then
    expect(sortedIds).toEqual(["1", "2"])
    expect(watermarkContent.trim()).toBe("2")
  } finally {
    await fixture.cleanup()
  }
}, 30_000)

test("#given traversal team run id #when creating a task #then no task directory escapes the team base", async () => {
  // given
  const fixture = await createTasklistFixture()
  const escapedDirectory = path.resolve(fixture.rootDirectory, "..", "escape")

  try {
    // when
    const createdTask = createTask("../../escape", createTaskInput(), fixture.config)

    // then
    await expect(createdTask).rejects.toThrow("team path escapes base directory")
    await expect(stat(escapedDirectory)).rejects.toBeInstanceOf(Error)
  } finally {
    await fixture.cleanup()
  }
})

type TaskChangeCase = {
  readonly operation: string
  readonly arrange: (teamRunId: string, config: TeamModeConfig) => Promise<() => Promise<unknown>>
  readonly expectedStatuses: readonly Task["status"][]
}

const taskChangeCases: readonly TaskChangeCase[] = [
  {
    operation: "createTask",
    arrange: async (teamRunId, config) => () => createTask(teamRunId, createTaskInput(), config),
    expectedStatuses: ["pending"],
  },
  {
    operation: "claimTask",
    arrange: async (teamRunId, config) => {
      const task = await createTask(teamRunId, createTaskInput(), config)
      return () => claimTask(teamRunId, task.id, "worker", config)
    },
    expectedStatuses: ["claimed"],
  },
  {
    operation: "updateTaskStatus",
    arrange: async (teamRunId, config) => {
      const task = await createTask(teamRunId, createTaskInput({ status: "claimed", owner: "worker" }), config)
      return () => updateTaskStatus(teamRunId, task.id, "in_progress", "worker", config)
    },
    expectedStatuses: ["in_progress"],
  },
  {
    operation: "updateTaskStatus from pending to completed",
    arrange: async (teamRunId, config) => {
      const task = await createTask(teamRunId, createTaskInput(), config)
      return () => updateTaskStatus(teamRunId, task.id, "completed", "worker", config)
    },
    expectedStatuses: ["claimed", "in_progress", "completed"],
  },
  {
    operation: "a rejected claim",
    arrange: async (teamRunId, config) => {
      const task = await createTask(teamRunId, createTaskInput({ status: "claimed", owner: "other" }), config)
      return () => expect(claimTask(teamRunId, task.id, "worker", config)).rejects.toBeInstanceOf(AlreadyClaimedError)
    },
    expectedStatuses: [],
  },
]

test.each(taskChangeCases)(
  "#given a subscriber #when $operation finishes #then each committed task write notifies once",
  async ({ arrange, expectedStatuses }) => {
    // given
    const fixture = await createTasklistFixture()
    const observed: Array<{ readonly teamRunId: string; readonly status: Task["status"] }> = []
    const taskPath = getTaskFilePath(resolveBaseDir(fixture.config), fixture.teamRunId, "1")
    const act = await arrange(fixture.teamRunId, fixture.config)
    const unsubscribe = subscribeTeamRuntimeChanges((teamRunId) => {
      observed.push({ teamRunId, status: TaskSchema.parse(JSON.parse(readFileSync(taskPath, "utf8"))).status })
    })

    try {
      // when
      await act()

      // then
      expect(observed).toEqual(expectedStatuses.map((status) => ({ teamRunId: fixture.teamRunId, status })))
    } finally {
      unsubscribe()
      await fixture.cleanup()
    }
  },
)

import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { BACKGROUND_OUTPUT_DESCRIPTION, BACKGROUND_TASK_DESCRIPTION } from "./constants"
import { createBackgroundOutput } from "./create-background-output"
import { createBackgroundTask } from "./create-background-task"

describe("background task tool descriptions", () => {
  test("#given background task descriptions #when creating tools #then shipped descriptions match their exports", () => {
    // given
    const manager = unsafeTestValue<Parameters<typeof createBackgroundTask>[0]>({})
    const client = unsafeTestValue<Parameters<typeof createBackgroundTask>[1]>({})

    // when
    const backgroundTask = createBackgroundTask(manager, client)
    const backgroundOutput = createBackgroundOutput(manager, client)

    // then
    expect(backgroundTask.description).toBe(BACKGROUND_TASK_DESCRIPTION)
    expect(backgroundOutput.description).toBe(BACKGROUND_OUTPUT_DESCRIPTION)
  })
})

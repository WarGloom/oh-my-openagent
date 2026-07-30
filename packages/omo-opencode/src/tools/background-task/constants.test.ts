import { describe, expect, test } from "bun:test"
import { BACKGROUND_OUTPUT_DESCRIPTION, BACKGROUND_TASK_DESCRIPTION } from "./constants"

describe("background task tool descriptions", () => {
  test("#given background task tools #when reading descriptions #then output collection waits for all-complete notification", () => {
    // then
    expect(BACKGROUND_TASK_DESCRIPTION).toContain("all-complete notification")
    expect(BACKGROUND_OUTPUT_DESCRIPTION).toContain("all-complete <system-reminder> notification")
    expect(BACKGROUND_OUTPUT_DESCRIPTION).toContain("partial notification")
    expect(BACKGROUND_OUTPUT_DESCRIPTION).not.toContain("notification for the task")
  })
})

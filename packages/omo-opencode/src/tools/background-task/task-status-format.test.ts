import { describe, expect, test } from "bun:test"
import type { BackgroundTask } from "../../features/background-agent"
import { formatTaskStatus } from "./task-status-format"

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "bg_status_model",
    description: "status model task",
    prompt: "inspect current model",
    agent: "sisyphus-junior",
    status: "running",
    parentSessionId: "parent-session",
    parentMessageId: "parent-message",
    startedAt: new Date("2026-06-02T18:00:00.000Z"),
    ...overrides,
  }
}

describe("formatTaskStatus", () => {
  test("#given task is running on fallback model #when formatting status #then current model is shown", () => {
    // given
    const task = createTask({
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    })

    // when
    const output = formatTaskStatus(task)

    // then
    expect(output).toContain("| Model | `openai/gpt-5.4-mini` |")
  })
})

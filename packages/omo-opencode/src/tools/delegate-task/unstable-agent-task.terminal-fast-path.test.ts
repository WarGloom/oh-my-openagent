/// <reference types="bun-types" />
import { describe, expect, spyOn, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { executeUnstableAgentTask } from "./unstable-agent-task"
import type { DelegateTaskArgs } from "./types"
import { bindAttemptSession, finalizeAttempt, startAttempt } from "../../features/background-agent/attempt-lifecycle"
import type { BackgroundTask, LaunchInput } from "../../features/background-agent/types"
import "./jev-routing-context"
import * as ledger from "./jev-routing-ledger"

const args: DelegateTaskArgs = {
  description: "terminal task",
  prompt: "do it",
  category: "quick",
  load_skills: [],
  run_in_background: false,
}

describe("executeUnstableAgentTask terminal fast path", () => {
  test("monitored unstable delegation preserves its decision through lifecycle outcomes", async () => {
    const decisionId = crypto.randomUUID()
    const records: ledger.JevRoutingRecord[] = []
    const recordSpy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
      records.push(record)
    })
    let task: BackgroundTask | undefined
    const manager = {
      launch: async (input: LaunchInput) => {
        task = { ...input, id: "bg_unstable", status: "pending" }
        const attempt = startAttempt(task, input.model)
        bindAttemptSession(task, attempt.attemptId, "unstable-child", input.model)
        task.result = "Done"
        finalizeAttempt(task, attempt.attemptId, "completed")
        return task
      },
      getTask: () => task,
    }
    try {
      const output = await executeUnstableAgentTask(
        { ...args, decisionId },
        { sessionID: "parent", messageID: "message", agent: "sisyphus", abort: new AbortController().signal },
        unsafeTestValue({
          manager,
          client: {
            session: {
              messages: async () => ({
                data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Done" }] }],
              }),
            },
          },
        }),
        { sessionID: "parent", messageID: "message" },
        "worker",
        { providerID: "test", modelID: "unstable" },
        undefined,
        "test/unstable",
      )
      expect(output).toContain("Done")
      expect(task?.decisionId).toBe(decisionId)
      expect(records.find((record) => record.event === "attempt" && record.child_session_id !== null)).toMatchObject({
        decision_id: decisionId,
        task_id: "bg_unstable",
        child_session_id: "unstable-child",
      })
      expect(records.find((record) => record.event === "outcome")).toMatchObject({
        decision_id: decisionId,
        task_id: "bg_unstable",
        status: "completed",
      })
    } finally {
      recordSpy.mockRestore()
    }
  })

  test("#given launched task is already interrupted #when monitoring starts #then it returns without waiting for the poll interval", async () => {
    // given
    const startedAt = Date.now()

    // when
    const output = await executeUnstableAgentTask(
      args,
      {
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "sisyphus",
        abort: new AbortController().signal,
      },
      unsafeTestValue({
        manager: {
          launch: async () => ({
            id: "bg_terminal",
            sessionId: "ses_terminal",
            description: "terminal task",
            agent: "sisyphus-junior",
            status: "interrupt",
            error: "already stopped",
          }),
          getTask: () => ({
            id: "bg_terminal",
            sessionId: "ses_terminal",
            description: "terminal task",
            agent: "sisyphus-junior",
            status: "interrupt",
            error: "already stopped",
          }),
        },
        client: {
          session: {
            status: async () => ({ data: {} }),
            messages: async () => ({ data: [] }),
          },
        },
      }),
      { sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus" },
      "sisyphus-junior",
      undefined,
      undefined,
      "test-model",
    )

    // then
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(output).toContain("SUPERVISED TASK FAILED")
    expect(output).toContain("already stopped")
  })
})

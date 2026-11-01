import { describe, expect, test } from "bun:test"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakeSessionInspector } from "./parent-wake-session-inspector"

const dispatchedAt = 1_000_000

function inspector(messages: readonly unknown[], awaitOpenAssistantOutput: boolean) {
  const client = { session: { messages: async () => ({ data: messages }) } }
  return new ParentWakeSessionInspector(client, {
    directory: "/tmp/test-omo",
    acceptedMessageSkewMs: 100,
    toolCallDeferMaxMs: 5_000,
    userMessageInProgressWindowMs: 0,
    awaitOpenAssistantOutput,
  })
}

const wake: PendingParentWake = { promptContext: {}, notifications: ["[BACKGROUND TASK COMPLETED]"], shouldReply: true, dispatchedAt }

// A V2 reply that started after the wake but has not streamed its content yet: only the step-start part is visible.
const openReply = { info: { role: "assistant", time: { created: dispatchedAt + 20 } }, parts: [{ type: "step-start" }] }

describe("parent wake output inspection for a reply that is still running", () => {
  test("#given a V2 host and an open reply without visible output #when the requeue window elapses #then the wake stays pending instead of resending", async () => {
    // given
    const subject = inspector([openReply], true)
    // when
    const result = await subject.hasAssistantOrToolOutputAfterDispatchedWake("ses_parent", wake)
    // then
    expect(result).toBe("unknown")
  })

  test("#given a V1 host and the same open reply #when the requeue window elapses #then the existing no-output result is kept", async () => {
    // given
    const subject = inspector([openReply], false)
    // when
    const result = await subject.hasAssistantOrToolOutputAfterDispatchedWake("ses_parent", wake)
    // then
    expect(result).toBe("no-output")
  })

  test("#given a V2 host and a reply that finished without output #when the requeue window elapses #then the wake is reported as unanswered", async () => {
    // given
    const subject = inspector([{ ...openReply, info: { ...openReply.info, time: { created: dispatchedAt + 20, completed: dispatchedAt + 900 } } }], true)
    // when
    const result = await subject.hasAssistantOrToolOutputAfterDispatchedWake("ses_parent", wake)
    // then
    expect(result).toBe("no-output")
  })
})

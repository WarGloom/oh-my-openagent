import { describe, expect, it, mock } from "bun:test"

const logMock = mock(() => {})

mock.module("../../shared/logger", () => ({
  log: logMock,
}))

const { handleNonIdleEvent } = await import("./non-idle-events")

describe("handleNonIdleEvent", () => {
  it("logs user-role wording for user message updates", () => {
    const cancelCountdown = mock(() => {})

    handleNonIdleEvent({
      eventType: "message.updated",
      properties: { info: { sessionID: "ses_test", role: "user" } },
      sessionStateStore: {
        getExistingState: () => undefined,
        cancelCountdown,
        cleanup: mock(() => {}),
      } as never,
    })

    expect(logMock).toHaveBeenCalledWith(
      "[todo-continuation-enforcer] Cancelling countdown on user-role message",
      { sessionID: "ses_test" }
    )
    expect(cancelCountdown).toHaveBeenCalledWith("ses_test")
  })
})

/// <reference path="../../../bun-test.d.ts" />

import { afterEach, describe, expect, it, mock } from "bun:test"

const logMock = mock((_message: string, _meta?: unknown) => {})

mock.module("../logger", () => ({
  log: logMock,
}))

const { dispatchAfterSessionIdle } = await import("./session-idle-dispatch")
const { clearPromptSkipLogStateForTesting } = await import("./skip-log-throttle")
const { clearPromptReservationsForTesting } = await import("./reservations")

function createActiveClient() {
  return {
    session: {
      status: async () => ({ data: { ses_active: { type: "busy" } } }),
    },
  }
}

function countActiveSkipLogs(): number {
  return logMock.mock.calls.filter(
    ([message]) =>
      typeof message === "string" &&
      message.includes("skipped because session is active"),
  ).length
}

describe("dispatchAfterSessionIdle skip-log throttling", () => {
  afterEach(() => {
    logMock.mockClear()
    clearPromptSkipLogStateForTesting()
    clearPromptReservationsForTesting()
  })

  it("#given the session stays active #when a queued prompt re-drains repeatedly #then the active-skip log emits once", async () => {
    // given
    const dispatch = mock(async () => ({}))
    const statuses: string[] = []

    // when
    for (let index = 0; index < 4; index++) {
      const result = await dispatchAfterSessionIdle({
        sessionName: "promptAsync",
        client: createActiveClient(),
        sessionID: "ses_active",
        input: { path: { id: "ses_active" }, body: { parts: [] } },
        source: "compaction-context-injector",
        dedupeKey: "recovery",
        settleMs: 0,
        postDispatchHoldMs: 0,
        semanticDedupeHoldMs: 0,
        dispatchTimeoutMs: 1000,
        checkStatus: true,
        checkToolState: false,
        dispatch,
      })
      statuses.push(result.status)
    }

    // then
    expect(statuses).toEqual(["active", "active", "active", "active"])
    expect(dispatch).not.toHaveBeenCalled()
    expect(countActiveSkipLogs()).toBe(1)
  })
})

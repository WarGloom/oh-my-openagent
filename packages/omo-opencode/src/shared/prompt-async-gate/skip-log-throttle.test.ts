/// <reference path="../../../bun-test.d.ts" />

import { afterEach, describe, expect, it } from "bun:test"
import {
  DEFAULT_PROMPT_SKIP_LOG_HEARTBEAT_MS,
  clearPromptSkipLogState,
  clearPromptSkipLogStateForTesting,
  shouldLogPromptSkip,
} from "./skip-log-throttle"

describe("shouldLogPromptSkip", () => {
  afterEach(() => {
    clearPromptSkipLogStateForTesting()
  })

  it("#given an identical skip reason #when it repeats inside the heartbeat window #then it logs only once", () => {
    // when
    const decisions: boolean[] = []
    for (let index = 0; index < 4; index++) {
      decisions.push(shouldLogPromptSkip("ses_a", "recovery", "active"))
    }

    // then
    expect(decisions).toEqual([true, false, false, false])
  })

  it("#given a changed skip status #when a different status is reported #then the new status logs once", () => {
    // when
    const firstActive = shouldLogPromptSkip("ses_a", "recovery", "active")
    const firstReserved = shouldLogPromptSkip("ses_a", "recovery", "reserved")
    const secondReserved = shouldLogPromptSkip("ses_a", "recovery", "reserved")

    // then
    expect(firstActive).toBe(true)
    expect(firstReserved).toBe(true)
    expect(secondReserved).toBe(false)
  })

  it("#given the heartbeat window elapses #when the same status repeats afterwards #then it logs again", () => {
    // given
    const originalDateNow = Date.now
    let now = originalDateNow()
    Date.now = () => now

    try {
      // when
      const first = shouldLogPromptSkip("ses_a", "recovery", "active")
      const suppressed = shouldLogPromptSkip("ses_a", "recovery", "active")
      now += DEFAULT_PROMPT_SKIP_LOG_HEARTBEAT_MS + 1
      const afterHeartbeat = shouldLogPromptSkip("ses_a", "recovery", "active")

      // then
      expect(first).toBe(true)
      expect(suppressed).toBe(false)
      expect(afterHeartbeat).toBe(true)
    } finally {
      Date.now = originalDateNow
    }
  })

  it("#given skip state was cleared #when the same status repeats #then it logs again", () => {
    // when
    const first = shouldLogPromptSkip("ses_a", "recovery", "active")
    const suppressed = shouldLogPromptSkip("ses_a", "recovery", "active")
    clearPromptSkipLogState("ses_a", "recovery")
    const afterClear = shouldLogPromptSkip("ses_a", "recovery", "active")

    // then
    expect(first).toBe(true)
    expect(suppressed).toBe(false)
    expect(afterClear).toBe(true)
  })

  it("#given distinct sessions #when each reports the same status #then they throttle independently", () => {
    // when
    const sessionA = shouldLogPromptSkip("ses_a", "recovery", "active")
    const sessionB = shouldLogPromptSkip("ses_b", "recovery", "active")
    const sessionAAgain = shouldLogPromptSkip("ses_a", "recovery", "active")

    // then
    expect(sessionA).toBe(true)
    expect(sessionB).toBe(true)
    expect(sessionAAgain).toBe(false)
  })
})

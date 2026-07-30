import { describe, expect, test } from "bun:test"

import { shouldRetryError } from "./model-error-classifier"

describe("model-error-classifier reset window signals", () => {
  test("#given session limit reset window #when retry classification runs #then it is retryable", () => {
    //#given
    const error = {
      message: "Claude Code returned an error result: You've hit your session limit · resets 2:30am (Asia/Jerusalem)",
    }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })
})

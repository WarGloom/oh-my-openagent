import { describe, expect, test } from "bun:test"
import type { BackgroundTask } from "./types"
import {
  clearProviderAutoRetryDeferral,
  getProviderAutoRetryDeferral,
} from "./provider-auto-retry-deferral"

const NOW = 1_800_000_000_000

function createTask(): BackgroundTask {
  return {
    attemptCount: 0,
    fallbackChain: [
      { providers: ["openai"], model: "gpt-5.6" },
      { providers: ["anthropic"], model: "claude-sonnet-4-6" },
    ],
  } as BackgroundTask
}

describe("provider auto-retry deferral", () => {
  test("hard provider exhaustion bypasses first-attempt deferral", () => {
    const deferral = getProviderAutoRetryDeferral(
      createTask(),
      {
        attempt: 1,
        message: "Too Many Requests: {\"error\":{\"message\":\"Sorry, you've exceeded your 5 hour session limits.\",\"code\":\"user_global_rate_limited:pro_plus\"}}",
      },
      NOW,
    )

    expect(deferral).toBeUndefined()
  })

  test("short transient provider retry retains one native retry", () => {
    const deferral = getProviderAutoRetryDeferral(
      createTask(),
      {
        attempt: 1,
        message: "Our servers are currently overloaded. Please try again later.",
        next: NOW + 5_000,
      },
      NOW,
    )

    expect(deferral).toEqual({
      retryAttempt: "1",
      providerRetryAttemptsBeforeFallback: 1,
    })
  })

  test.each([
    ["expired", NOW - 1],
    ["too distant", NOW + 30_001],
    ["invalid", Number.NaN],
  ])("%s provider retry deadline bypasses deferral", (_label, next) => {
    const deferral = getProviderAutoRetryDeferral(
      createTask(),
      {
        attempt: 1,
        message: "Our servers are currently overloaded. Please try again later.",
        next,
      },
      NOW,
    )

    expect(deferral).toBeUndefined()
  })

  test("unchanged retry without a deadline stops deferring after thirty seconds", () => {
    const task = createTask()
    const status = {
      attempt: 1,
      message: "Our servers are currently overloaded. Please try again later.",
    }

    expect(getProviderAutoRetryDeferral(task, status, NOW)).toBeDefined()
    expect(getProviderAutoRetryDeferral(task, status, NOW + 29_999)).toBeDefined()
    expect(getProviderAutoRetryDeferral(task, status, NOW + 30_000)).toBeUndefined()
    expect(getProviderAutoRetryDeferral(task, status, NOW + 31_000)).toBeUndefined()
  })

  test("changing retry deadlines cannot reset the thirty-second bound", () => {
    const task = createTask()
    const status = {
      attempt: 1,
      message: "Our servers are currently overloaded. Please try again later.",
    }

    expect(getProviderAutoRetryDeferral(task, { ...status, next: NOW + 5_000 }, NOW)).toBeDefined()
    expect(getProviderAutoRetryDeferral(
      task,
      { ...status, next: NOW + 34_999 },
      NOW + 29_999,
    )).toBeDefined()
    expect(getProviderAutoRetryDeferral(
      task,
      { ...status, next: NOW + 35_000 },
      NOW + 30_000,
    )).toBeUndefined()
  })

  test("leaving retry state gives a later retry cycle a fresh window", () => {
    const task = createTask()
    const status = {
      attempt: 1,
      message: "Our servers are currently overloaded. Please try again later.",
    }

    expect(getProviderAutoRetryDeferral(task, status, NOW)).toBeDefined()
    clearProviderAutoRetryDeferral(task)
    expect(getProviderAutoRetryDeferral(task, status, NOW + 60_000)).toBeDefined()
  })
})

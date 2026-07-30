import { describe, expect, test } from "bun:test"

import {
  classifyProviderExhaustionFallbackSignal,
  isProviderExhaustionFallbackEligible,
} from "./provider-exhaustion-fallback-policy"
import { shouldRetryError } from "./model-error-classifier"

describe("provider exhaustion fallback policy", () => {
  test("#given quota subscription and billing exhaustion #when checked for provider fallback #then they are eligible without weakening legacy stop semantics", () => {
    //#given
    const errors = [
      { name: "QuotaExceededError", message: "Quota exceeded for this billing period." },
      { message: "Subscription limit exceeded. You can continue using free models." },
      { name: "BillingError", message: "Billing hard limit reached for this account." },
      { name: "SessionRetry", message: "Claude Code returned an error result: You've hit your monthly spend limit · raise it at claude.ai/settings/usage" },
      { message: "Payment required: out of credits." },
      { message: "Credit balance too low for this request." },
    ] as const

    //#when
    const providerExhaustionResults = errors.map((error) => ({
      signal: classifyProviderExhaustionFallbackSignal(error),
      eligible: isProviderExhaustionFallbackEligible(error),
    }))
    const legacyRetryResults = errors.map((error) => shouldRetryError(error))

    //#then
    expect(providerExhaustionResults).toEqual(
      errors.map(() => ({ signal: "quota_exceeded", eligible: true })),
    )
    expect(legacyRetryResults).toEqual(errors.map(() => false))
  })

  test("#given session limit reset window #when checked for provider fallback #then it is eligible and retryable", () => {
    //#given
    const error = {
      name: "SessionRetry",
      message: "Claude Code returned an error result: You've hit your session limit · resets 2:30am (Asia/Jerusalem)",
    }

    //#when
    const providerExhaustionResult = {
      signal: classifyProviderExhaustionFallbackSignal(error),
      eligible: isProviderExhaustionFallbackEligible(error),
    }
    const legacyRetryResult = shouldRetryError(error)

    //#then
    expect(providerExhaustionResult).toEqual({ signal: "quota_exceeded", eligible: true })
    expect(legacyRetryResult).toBe(true)
  })

  test("#given GitHub Copilot Pro Plus five-hour session limit #when checked for provider fallback #then it is eligible", () => {
    //#given
    const error = {
      name: "SessionRetry",
      message: "Too Many Requests: {\"error\":{\"message\":\"Sorry, you've exceeded your 5 hour session limits.\",\"code\":\"user_global_rate_limited:pro_plus\"}}",
    }

    //#when
    const providerExhaustionResult = {
      signal: classifyProviderExhaustionFallbackSignal(error),
      eligible: isProviderExhaustionFallbackEligible(error),
    }

    //#then
    expect(providerExhaustionResult).toEqual({ signal: "quota_exceeded", eligible: true })
  })

  test("#given GitHub Copilot weekly rate limit #when checked for provider fallback #then it is eligible", () => {
    //#given
    const error = {
      name: "SessionRetry",
      message: "Too Many Requests: {\"error\":{\"message\":\"Sorry, you've exceeded your weekly rate limit. Please review our Terms of Service.\",\"code\":\"user_weekly_rate_limited\"}}",
    }

    //#when
    const providerExhaustionResult = {
      signal: classifyProviderExhaustionFallbackSignal(error),
      eligible: isProviderExhaustionFallbackEligible(error),
    }

    //#then
    expect(providerExhaustionResult).toEqual({ signal: "quota_exceeded", eligible: true })
  })

  test("#given hard-stop runtime errors #when checked for provider exhaustion fallback #then they stay ineligible", () => {
    //#given
    const hardStopErrors = [
      { name: "MessageAbortedError", message: "The user aborted this request." },
      {
        name: "AI_LoadAPIKeyError",
        message: "API key is missing from the OPENAI_API_KEY environment variable.",
      },
      { message: "API key must be a string." },
      { name: "ValidationError", message: "Invalid request payload." },
    ] as const

    //#when
    const results = hardStopErrors.map((error) => ({
      signal: classifyProviderExhaustionFallbackSignal(error),
      eligible: isProviderExhaustionFallbackEligible(error),
    }))

    //#then
    expect(results).toEqual(
      hardStopErrors.map(() => ({ signal: undefined, eligible: false })),
    )
  })
})

/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  createFallbackState,
  findNextAvailableFallback,
  prepareFallback,
  stringifyRuntimeModelWithVariant,
} from "./fallback-state"
import { DEFAULT_CONFIG } from "./constants"

describe("runtime-fallback fallback state", () => {
  test("wraps to an expired earlier model, skips cooldowns, and stops at the attempt bound", () => {
    // given
    const models = ["openai/first", "anthropic/second", "spark2/third"]
    const state = createFallbackState("spark2/third")
    state.fallbackIndex = 2
    state.failedModels.set("openai/first", 0)
    state.failedModels.set("anthropic/second", Date.now())
    const config = { ...DEFAULT_CONFIG, max_fallback_attempts: 2 }

    // when
    const first = prepareFallback("ses_wrap", state, models, config)
    const second = prepareFallback("ses_wrap", state, models, { ...config, cooldown_seconds: 0 })
    const exhausted = prepareFallback("ses_wrap", state, models, { ...config, cooldown_seconds: 0 })

    // then
    expect([first.newModel, second.newModel]).toEqual(["openai/first", "anthropic/second"])
    expect(exhausted).toMatchObject({ success: false, maxAttemptsReached: true })
    expect(state.attemptCount).toBe(2)
  })

  test("returns no candidate when a circular chain contains only the current model or cooldowns", () => {
    // given
    const state = createFallbackState("openai/first")
    state.fallbackIndex = 1
    state.failedModels.set("anthropic/second", Date.now())
    // when / then
    expect(findNextAvailableFallback(state, ["anthropic/second", "openai/first"], 60)).toBeUndefined()
    expect(findNextAvailableFallback(state, [], 60)).toBeUndefined()
  })

  test("#given object-shaped current model #when finding the next fallback #then equivalent models are skipped without crashing", () => {
    // given
    const state = createFallbackState({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
    const fallbackModels = ["github-copilot/claude-sonnet-4.6", "openai/gpt-5.4"]

    // when
    const nextModel = findNextAvailableFallback(state, fallbackModels, 60)

    // then
    expect(nextModel).toBe("openai/gpt-5.4")
  })

  test("#given model object without variant and top-level variant #when stringifying runtime model #then top-level variant is preserved", () => {
    // given
    const model = { providerID: "github-copilot", modelID: "claude-haiku-4.5" }

    // when
    const runtimeModel = stringifyRuntimeModelWithVariant(model, "high")

    // then
    expect(runtimeModel).toBe("github-copilot/claude-haiku-4.5(high)")
  })

  test("#given model object with its own variant #when stringifying with a top-level variant #then model variant wins", () => {
    // given
    const model = { providerID: "github-copilot", modelID: "claude-haiku-4.5", variant: "low" }

    // when
    const runtimeModel = stringifyRuntimeModelWithVariant(model, "high")

    // then
    expect(runtimeModel).toBe("github-copilot/claude-haiku-4.5(low)")
  })
})

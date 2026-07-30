import { describe, expect, test } from "bun:test"

import { areRuntimeFallbackModelsEquivalent } from "./runtime-fallback-model"

describe("runtime fallback model identity", () => {
  test("#given equivalent model with variant suffix #when comparing fallback identities #then variant is ignored", () => {
    //#given
    const currentModel = "anthropic/claude-opus-4-7"
    const fallbackModel = "anthropic/claude-opus-4-7(max)"

    //#when
    const equivalent = areRuntimeFallbackModelsEquivalent(fallbackModel, currentModel)

    //#then
    expect(equivalent).toBe(true)
  })
})

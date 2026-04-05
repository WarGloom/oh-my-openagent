import { beforeEach, describe, expect, mock, test, spyOn } from "bun:test"
import * as connectedProvidersCache from "./connected-providers-cache"

let resolveModelPipeline: typeof import("./model-resolution-pipeline").resolveModelPipeline

beforeEach(async () => {
  mock.restore()
  ;({ resolveModelPipeline } = await import(`./model-resolution-pipeline?test=${Date.now()}-${Math.random()}`))
})

describe("resolveModelPipeline", () => {
  test("does not return unused explicit user config metadata in override result", () => {
    // given
    const result = resolveModelPipeline({
      intent: {
        userModel: "openai/gpt-5.3-codex",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
    })

    // when
    const hasExplicitUserConfigField = result
      ? Object.prototype.hasOwnProperty.call(result, "explicitUserConfig")
      : false

    // then
    expect(result).toEqual({ model: "openai/gpt-5.3-codex", provenance: "override" })
    expect(hasExplicitUserConfigField).toBe(false)
  })

  test("uses user fallback model before hardcoded fallback chain when cache indicates provider is connected", () => {
    // given
    const readConnectedProvidersCacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai", "anthropic"])

    // when
    const result = resolveModelPipeline({
      intent: {
        userFallbackModels: ["anthropic/claude-opus-4-6", "openai/gpt-5.4"],
      },
      constraints: {
        availableModels: new Set<string>(),
      },
      policy: {
        fallbackChain: [
          { providers: ["anthropic"], model: "claude-opus-4-6" },
        ],
        systemDefaultModel: "google/gemini-3.1-pro",
      },
    })

    // then
    expect(result).toEqual({
      model: "anthropic/claude-opus-4-6",
      provenance: "provider-fallback",
      attempted: ["anthropic/claude-opus-4-6"],
    })
    readConnectedProvidersCacheSpy.mockRestore()
  })

  test("skips hardcoded fallback when user fallback model is providerless and connected provider exists", () => {
    // given
    const readConnectedProvidersCacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])

    // when
    const result = resolveModelPipeline({
      intent: {
        userFallbackModels: ["gpt-5.4", "anthropic/claude-opus-4-6"],
      },
      constraints: {
        availableModels: new Set<string>(),
      },
      policy: {
        fallbackChain: [
          { providers: ["anthropic"], model: "claude-opus-4-6" },
        ],
        systemDefaultModel: "google/gemini-3.1-pro",
      },
    })

    // then
    expect(result).toEqual({
      model: "openai/gpt-5.4",
      provenance: "provider-fallback",
      attempted: ["gpt-5.4"],
    })
    readConnectedProvidersCacheSpy.mockRestore()
  })
  test("parses providerless fallback with variant suffix before hardcoded chain", () => {
    // given
    const readConnectedProvidersCacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])

    // when
    const result = resolveModelPipeline({
      intent: {
        userFallbackModels: ["gpt-5.4 high", "anthropic/claude-opus-4-6"],
      },
      constraints: {
        availableModels: new Set<string>(),
      },
      policy: {
        fallbackChain: [
          { providers: ["anthropic"], model: "claude-opus-4-6" },
        ],
        systemDefaultModel: "google/gemini-3.1-pro",
      },
    })

    // then
    expect(result).toEqual({
      model: "openai/gpt-5.4",
      provenance: "provider-fallback",
      attempted: ["gpt-5.4 high"],
    })
    readConnectedProvidersCacheSpy.mockRestore()
  })


})

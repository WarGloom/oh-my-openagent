/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { applyProviderConfig } from "./provider-config-handler"
import { createModelCacheState } from "../plugin-state"
import { clearVisionCapableModelsCache, readVisionCapableModelsCache } from "../shared/vision-capable-models-cache"

describe("applyProviderConfig", () => {
  test("clears stale model context limits when provider config changes", () => {
    // given
    const modelCacheState = createModelCacheState()
    applyProviderConfig({
      config: {
        provider: {
          opencode: {
            models: {
              "kimi-k2.5-free": {
                limit: { context: 262144 },
              },
            },
          },
        },
      },
      modelCacheState,
    })

    // when
    applyProviderConfig({
      config: {
        provider: {
          google: {
            models: {
              "gemini-2.5-pro": {
                limit: { context: 1048576 },
              },
            },
          },
        },
      },
      modelCacheState,
    })

    // then
    expect(Array.from(modelCacheState.modelContextLimitsCache.entries())).toEqual([
      ["google/gemini-2.5-pro", 1048576],
    ])
  })

  test("keeps anthropicContext1MEnabled when anthropic-beta contains context-1m", () => {
    // given
    const modelCacheState = createModelCacheState()

    // when
    applyProviderConfig({
      config: {
        provider: {
          anthropic: {
            options: {
              headers: {
                "anthropic-beta": "context-1m",
              },
            },
          },
        },
      },
      modelCacheState,
    })

    // then
    expect(modelCacheState.anthropicContext1MEnabled).toBe(true)
  })

  test("disables anthropicContext1MEnabled when experimental flag is enabled", () => {
    // given
    const modelCacheState = createModelCacheState()

    // when
    applyProviderConfig({
      config: {
        provider: {
          anthropic: {
            options: {
              headers: {
                "anthropic-beta": "context-1m",
              },
            },
          },
        },
      },
      modelCacheState,
      experimental: {
        disableAnthropicBetaHeaders: true,
      },
    })

    // then
    expect(modelCacheState.anthropicContext1MEnabled).toBe(false)
  })

  test("wraps anthropic provider fetch to strip anthropic-beta headers when experimental flag is enabled", async () => {
    // given
    const modelCacheState = createModelCacheState()
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const config = {
      provider: {
        anthropic: {
          options: {
            headers: {
              "anthropic-beta": "interleaved-thinking-2025-05-14",
            },
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              fetchCalls.push({ input, init })
              return new Response(null, { status: 204 })
            },
          },
        },
      },
    } satisfies Record<string, unknown>

    // when
    applyProviderConfig({
      config,
      modelCacheState,
      experimental: {
        disableAnthropicBetaHeaders: true,
      },
    })

    const wrappedFetch = ((config.provider as Record<string, { options?: { fetch?: typeof fetch; headers?: Record<string, string> } }>).anthropic?.options?.fetch)
    if (!wrappedFetch) {
      throw new Error("Expected anthropic fetch wrapper to be installed")
    }

    await wrappedFetch("https://example.com", {
      headers: {
        "anthropic-beta": "context-1m-2025-08-07",
        "x-test": "1",
      },
    })

    // then
    expect(fetchCalls).toHaveLength(1)
    expect(new Headers(fetchCalls[0]?.init?.headers).get("anthropic-beta")).toBeNull()
    expect(new Headers(fetchCalls[0]?.init?.headers).get("x-test")).toBe("1")
    expect(((config.provider as Record<string, { options?: { headers?: Record<string, string> } }>).anthropic?.options?.headers ?? {})["anthropic-beta"]).toBeUndefined()
  })

  test("caches vision-capable models from modalities and capabilities", () => {
    // given
    const modelCacheState = createModelCacheState()
    const visionCapableModelsCache = modelCacheState.visionCapableModelsCache
    if (!visionCapableModelsCache) {
      throw new Error("visionCapableModelsCache should be initialized")
    }
    const config = {
      provider: {
        rundao: {
          models: {
            "public/qwen3.5-397b": {
              modalities: {
                input: ["text", "image"],
              },
            },
            "public/text-only": {
              modalities: {
                input: ["text"],
              },
            },
          },
        },
        google: {
          models: {
            "gemini-3-flash": {
              capabilities: {
                input: {
                  image: true,
                },
              },
            },
          },
        },
      },
    } satisfies Record<string, unknown>

    // when
    applyProviderConfig({ config, modelCacheState })

    // then
    expect(Array.from(visionCapableModelsCache.keys())).toEqual([
      "rundao/public/qwen3.5-397b",
      "google/gemini-3-flash",
    ])
    expect(readVisionCapableModelsCache()).toEqual([
      { providerID: "rundao", modelID: "public/qwen3.5-397b" },
      { providerID: "google", modelID: "gemini-3-flash" },
    ])
  })

  test("clears stale vision-capable models when provider config changes", () => {
    // given
    const modelCacheState = createModelCacheState()
    const visionCapableModelsCache = modelCacheState.visionCapableModelsCache
    if (!visionCapableModelsCache) {
      throw new Error("visionCapableModelsCache should be initialized")
    }
    visionCapableModelsCache.set("stale/old-model", {
      providerID: "stale",
      modelID: "old-model",
    })

    // when
    applyProviderConfig({
      config: { provider: {} },
      modelCacheState,
    })

    // then
    expect(visionCapableModelsCache.size).toBe(0)
    expect(readVisionCapableModelsCache()).toEqual([])
  })
})

clearVisionCapableModelsCache()

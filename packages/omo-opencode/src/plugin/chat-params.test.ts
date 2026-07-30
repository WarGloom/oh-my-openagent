import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChatParamsHandler, type ChatParamsOutput } from "./chat-params"
import * as dataPathModule from "../shared/data-path"
import * as sharedModule from "../shared"
import { _resetProviderAuthCacheForTesting } from "../shared/opencode-provider-auth"
import {
  clearSessionPromptParams,
  getSessionPromptParams,
  setSessionPromptParams,
} from "../shared/session-prompt-params-state"

describe("createChatParamsHandler", () => {
  let tempCacheRoot = ""
  let getCacheDirSpy: ReturnType<typeof spyOn>
  const originalXdgDataHome = process.env.XDG_DATA_HOME

  function writeAuthFile(providerEntries: Record<string, Record<string, unknown>>): void {
    const opencodeDir = join(tempCacheRoot, "opencode")
    mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(join(opencodeDir, "auth.json"), JSON.stringify(providerEntries), "utf-8")
    _resetProviderAuthCacheForTesting()
  }

  beforeEach(() => {
    tempCacheRoot = mkdtempSync(join(tmpdir(), "chat-params-cache-"))
    process.env.XDG_DATA_HOME = tempCacheRoot
    getCacheDirSpy = spyOn(dataPathModule, "getOmoOpenCodeCacheDir").mockReturnValue(
      join(tempCacheRoot, "oh-my-opencode"),
    )
    sharedModule.writeProviderModelsCache({ connected: [], models: {} })
  })

  afterEach(() => {
    clearSessionPromptParams("ses_chat_params")
    clearSessionPromptParams("ses_chat_params_temperature")
    sharedModule.writeProviderModelsCache({ connected: [], models: {} })
    _resetProviderAuthCacheForTesting()
    getCacheDirSpy?.mockRestore()
    if (tempCacheRoot) {
      rmSync(tempCacheRoot, { recursive: true, force: true })
    }
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    }
  })

  test("applies stored prompt params for the session", async () => {
    //#given
    sharedModule.writeProviderModelsCache({
      connected: ["openai"],
      models: {
        openai: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            temperature: true,
            reasoning: true,
            variants: {
              low: {},
              high: {},
            },
            limit: { output: 128_000 },
          },
        ],
      },
    })

    setSessionPromptParams("ses_chat_params_temperature", {
      temperature: 0.4,
      topP: 0.7,
      maxOutputTokens: 4096,
      options: {
        reasoningEffort: "high",
        thinking: { type: "disabled" },
      },
    })

    const handler = createChatParamsHandler()

    const input = {
      sessionID: "ses_chat_params_temperature",
      agent: { name: "oracle" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      provider: { id: "openai" },
      message: {},
    }

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: { existing: true },
    }

    //#when
    await handler(input, output)

    //#then
    expect(output).toEqual({
      temperature: 0.4,
      topP: 0.7,
      topK: 1,
      maxOutputTokens: 4096,
      options: {
        existing: true,
        reasoningEffort: "high",
        thinking: { type: "disabled" },
      },
    })
    expect(getSessionPromptParams("ses_chat_params_temperature")).toEqual({
      temperature: 0.4,
      topP: 0.7,
      maxOutputTokens: 4096,
      options: {
        reasoningEffort: "high",
        thinking: { type: "disabled" },
      },
    })
  })

  test("drops gpt-5.4 temperature and clamps maxOutputTokens from bundled model capabilities", async () => {
    //#given
    setSessionPromptParams("ses_chat_params_temperature", {
      temperature: 0.7,
      maxOutputTokens: 200_000,
    })

    const handler = createChatParamsHandler()

    const input = {
      sessionID: "ses_chat_params_temperature",
      agent: { name: "oracle" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      provider: { id: "openai" },
      message: {},
    }

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output).toEqual({
      topP: 1,
      topK: 1,
      maxOutputTokens: 128_000,
      options: {},
    })
  })

  test("drops unsupported reasoning settings from bundled model capabilities", async () => {
    //#given
    setSessionPromptParams("ses_chat_params", {
      temperature: 0.4,
      options: {
        reasoningEffort: "high",
        thinking: { type: "enabled", budgetTokens: 4096 },
      },
    })

    const handler = createChatParamsHandler()

    const input = {
      sessionID: "ses_chat_params",
      agent: { name: "oracle" },
      model: { providerID: "openai", modelID: "gpt-4.1" },
      provider: { id: "openai" },
      message: {},
    }

    const output = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output).toEqual({
      temperature: 0.4,
      topP: 1,
      topK: 1,
      options: {},
    })
  })

  test("falls back to default maxOutputTokens when stored and compatibility tokens are non-positive", async () => {
    //#given
    const logSpy = spyOn(sharedModule, "log").mockImplementation(() => undefined)
    setSessionPromptParams("ses_chat_params", {
      maxOutputTokens: 0,
    })

    const handler = createChatParamsHandler()

    const input = {
      sessionID: "ses_chat_params",
      agent: { name: "oracle" },
      model: { providerID: "custom-provider", modelID: "custom-model" },
      provider: { id: "custom-provider" },
      message: {},
    }

    const output: ChatParamsOutput = {
      topP: 1,
      topK: 1,
      maxOutputTokens: 0,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output.maxOutputTokens).toBe(4096)
    expect(logSpy).toHaveBeenCalledWith(
      "[plugin] maxOutputTokens=0 is non-positive; using safe fallback 4096",
    )

    logSpy.mockRestore()
  })

  test("uses safe fallback instead of model max when stored maxOutputTokens is non-positive", async () => {
    //#given
    setSessionPromptParams("ses_chat_params", {
      maxOutputTokens: -1,
    })

    const handler = createChatParamsHandler()

    const input = {
      sessionID: "ses_chat_params",
      agent: { name: "oracle" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      provider: { id: "openai" },
      message: {},
    }

    const output: ChatParamsOutput = {
      topP: 1,
      topK: 1,
      maxOutputTokens: -1,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output.maxOutputTokens).toBe(4096)
  })

  test("drops thinking for anthropic oauth sessions", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "oauth" } })
    setSessionPromptParams("ses_chat_params", {
      options: {
        thinking: { type: "enabled", budgetTokens: 4096 },
      },
    })

    const handler = createChatParamsHandler({
      anthropicEffort: null,
    })

    const input = {
      sessionID: "ses_chat_params",
      agent: { name: "oracle" },
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      provider: { id: "anthropic" },
      message: {},
    }

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output.options.thinking).toBeUndefined()
  })

  test("preserves thinking for anthropic api-key sessions", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    setSessionPromptParams("ses_chat_params", {
      options: {
        thinking: { type: "enabled", budgetTokens: 4096 },
      },
    })

    const handler = createChatParamsHandler({
      anthropicEffort: null,
    })

    const input = {
      sessionID: "ses_chat_params",
      agent: { name: "oracle" },
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      provider: { id: "anthropic" },
      message: {},
    }

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(input, output)

    //#then
    expect(output.options.thinking).toEqual({ type: "enabled", budgetTokens: 4096 })
  })

  test("injects anthropicAdvisor when experimental advisor config is enabled", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
          advisor_model: "claude-opus-4-7",
          max_uses: 2,
          caching_ttl: "5m",
          agents: ["oracle"],
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toEqual({
      model: "claude-opus-4-7",
      maxUses: 2,
      caching: { ttl: "5m" },
    })
  })

  test("does not inject anthropicAdvisor when agent is not allowed", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
          agents: ["sisyphus"],
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toBeUndefined()
  })

  test("does not inject anthropicAdvisor for anthropic oauth sessions", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "oauth" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toBeUndefined()
  })

  test("does not inject anthropicAdvisor when experimental advisor is explicitly disabled", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: false,
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toBeUndefined()
  })

  test("does not inject anthropicAdvisor for non-anthropic providers", async () => {
    //#given
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "openai", modelID: "gpt-5.4" },
        provider: { id: "openai" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toBeUndefined()
  })

  test("injects anthropicAdvisor for provider-prefixed matching executor model", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
          executor_models: ["anthropic/claude-sonnet-4-6"],
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "anthropic/claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toEqual({ model: "claude-opus-4-7" })
  })

  test("does not inject anthropicAdvisor when custom executor model list does not match", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
          executor_models: ["claude-opus-4-7"],
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {},
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toBeUndefined()
  })

  test("does not override an existing anthropicAdvisor option", async () => {
    //#given
    writeAuthFile({ anthropic: { type: "api", key: "sk-ant-xxx" } })
    const handler = createChatParamsHandler({
      anthropicEffort: null,
      experimental: {
        anthropicAdvisor: {
          enabled: true,
          max_uses: 2,
        },
      },
    })

    const output: ChatParamsOutput = {
      temperature: 0.1,
      topP: 1,
      topK: 1,
      options: {
        anthropicAdvisor: {
          model: "claude-opus-4-7",
          maxUses: 9,
        },
      },
    }

    //#when
    await handler(
      {
        sessionID: "ses_chat_params",
        agent: { name: "oracle" },
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        provider: { id: "anthropic" },
        message: {},
      },
      output,
    )

    //#then
    expect(output.options.anthropicAdvisor).toEqual({
      model: "claude-opus-4-7",
      maxUses: 9,
    })
  })
})

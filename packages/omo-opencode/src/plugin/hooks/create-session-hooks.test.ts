import { describe, expect, it } from "bun:test"
import type { OhMyOpenCodeConfig } from "../../config"
import type { BackgroundManager } from "../../features/background-agent"
import type { ModelCacheState } from "../../plugin-state"
import type { PluginContext } from "../types"
import { createSessionHooks } from "./create-session-hooks"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createPluginInput } from "../../v2/create-plugin-input"
import { createFakePluginContext } from "../../v2/fake-plugin-context"
import { createSessionTracker } from "../../v2/session-tracker"

const mockContext = unsafeTestValue<PluginContext>({
  directory: "/tmp",
  client: {
    tui: {
      showToast: async () => ({}),
    },
    session: {
      get: async () => ({ data: null }),
      update: async () => ({}),
    },
  },
})

const mockModelCacheState = {} as ModelCacheState
const mockBackgroundManager = unsafeTestValue<BackgroundManager>({})

describe("createSessionHooks", () => {
  it("leaves compaction and overflow recovery to V2 while preserving V1 hooks", () => {
    const fake = createFakePluginContext()
    const native = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    const results = [mockContext, native].map((ctx) => createSessionHooks({
      ctx, pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({ experimental: { preemptive_compaction: true } }),
      modelCacheState: mockModelCacheState, backgroundManager: mockBackgroundManager,
      isHookEnabled: (name) => name === "preemptive-compaction" || name === "anthropic-context-window-limit-recovery", safeHookEnabled: false,
    }))
    expect(results[0]?.preemptiveCompaction).not.toBeNull()
    expect(results[0]?.anthropicContextWindowLimitRecovery).not.toBeNull()
    expect(results[1]?.preemptiveCompaction).toBeNull()
    expect(results[1]?.anthropicContextWindowLimitRecovery).toBeNull()
  })
  it("keeps model fallback disabled when config is unset", () => {
    // given
    const pluginConfig = {} as OhMyOpenCodeConfig

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName) => hookName === "model-fallback",
      safeHookEnabled: true,
    })

    // then
    expect(result.modelFallback).toBeNull()
  })

  it("creates model fallback hook when config explicitly enables it", () => {
    // given
    const pluginConfig = { model_fallback: true } as OhMyOpenCodeConfig

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName) => hookName === "model-fallback",
      safeHookEnabled: true,
    })

    // then
    expect(result.modelFallback).not.toBeNull()
  })

  it("does not create removed context window monitor hook", () => {
    // given
    const pluginConfig = {} as OhMyOpenCodeConfig

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName: string) => hookName === "context-window-monitor",
      safeHookEnabled: true,
    })

    // then
    expect("contextWindowMonitor" in result).toBe(false)
  })

  it("skips interactive bash session hook when tmux integration is disabled", () => {
    // given
    const pluginConfig = {
      tmux: {
        enabled: false,
        layout: "main-vertical",
        main_pane_size: 60,
        main_pane_min_width: 120,
        agent_pane_min_width: 40,
        isolation: "inline",
      },
    } as OhMyOpenCodeConfig

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName) => hookName === "interactive-bash-session",
      safeHookEnabled: true,
    })

    // then
    expect(result.interactiveBashSession).toBeNull()
  })

  it("skips ast-grep sg provision when disabled hooks exclude it", () => {
    // given
    const pluginConfig = unsafeTestValue<OhMyOpenCodeConfig>({})

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName) => hookName !== "ast-grep-sg-provision",
      safeHookEnabled: true,
    })

    // then
    expect(result.astGrepSgProvision).toBeNull()
  })

  it("keeps ast-grep sg provision registered when the hook is enabled", () => {
    // given
    const pluginConfig = unsafeTestValue<OhMyOpenCodeConfig>({})

    // when
    const result = createSessionHooks({
      ctx: mockContext,
      pluginConfig,
      modelCacheState: mockModelCacheState,
      backgroundManager: mockBackgroundManager,
      isHookEnabled: (hookName) => hookName === "ast-grep-sg-provision",
      safeHookEnabled: true,
    })

    // then
    expect(result.astGrepSgProvision).not.toBeNull()
  })
})

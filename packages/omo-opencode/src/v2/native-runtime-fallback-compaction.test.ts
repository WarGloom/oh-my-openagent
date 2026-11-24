import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"
import { createPluginInput } from "./create-plugin-input"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createSessionTracker } from "./session-tracker"

test.each([
  { scenario: "exact model with a variant", model: { providerID: "anthropic", id: "first", variant: "high" }, seconds: 4 },
  { scenario: "provider only", model: { providerID: "anthropic", id: "first-extra" }, seconds: 3 },
  { scenario: "same model ID on another provider", model: { providerID: "openai", id: "first" }, seconds: 2 },
  { scenario: "global without a match", model: { providerID: "other", id: "first" }, seconds: 1 },
  { scenario: "explicit zero", model: { providerID: "anthropic", id: "untimed" }, seconds: 0 },
  { scenario: "new provider after fallback", model: { providerID: "openai", id: "first" }, seconds: 2, fallback: true },
])("uses the native first-response deadline for $scenario", async ({ model, seconds, fallback }) => {
  const clock = installRuntimeFallbackTestClock()
  const sessionID = "ses_first_response_override"
  const first = { providerID: "anthropic", id: "first" }
  const fake = createFakePluginContext({ sessionInfo: { model: fallback ? first : model, parentID: "parent" } })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const pluginConfig = OhMyOpenCodeConfigSchema.parse({
    agents: { sisyphus: { fallback_models: ["openai/first"] } },
    runtime_fallback: {
      enabled: true,
      timeout_seconds: 1,
      first_prompt_timeout_seconds: 1,
      stall_timeout_seconds: 0,
      hard_timeout_seconds: 0,
      provider_timeouts: { anthropic: 3, openai: 2 },
      model_timeouts: { "anthropic/first": 4, "anthropic/untimed": 0 },
    },
  })
  const config = pluginConfig.runtime_fallback
  if (typeof config !== "object") throw new Error("Runtime fallback config was not parsed")
  const runtime = createRuntimeFallbackHook(input, { pluginConfig, config })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(fake.context, hooks)
  try {
    if (!installed) throw new Error("Native fallback was not installed")
    const request = { sessionID, agent: "sisyphus", kind: "primary" as const, headers: {} }
    if (fallback) {
      await fake.triggerModelRequest({ ...request, model: first })
      await fake.triggerRetry({
        ...request,
        model: first,
        error: { type: "provider.quota", status: 402, message: "Quota exhausted" },
        attempt: 3,
        decision: { retry: true, delay: 0 },
      })
    }
    const executing = (await fake.context.session.get({ sessionID })).model
    expect(executing).toMatchObject(model)
    if (!executing) throw new Error("The native session has no model")
    await fake.triggerModelRequest({ ...request, model: executing })
    const interrupts = () => fake.sessionCalls.filter((call) => call.kind === "interrupt")
    await clock.advanceBy(seconds === 0 ? 5_000 : seconds * 1000 - 1)
    expect(interrupts()).toEqual([])
    if (seconds > 0) {
      await clock.advanceBy(1)
      expect(interrupts()).toEqual([{ kind: "interrupt", sessionID }])
    }
  } finally {
    runtime.native?.forget(sessionID)
    await installed?.dispose()
    runtime.dispose?.()
    clock.restore()
  }
})

test.each(["retry", "terminal"] as const)("compaction %s failures preserve the selected primary", async (source) => {
  const sessionID = "ses_compaction_ownership"
  const model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const error = { type: "provider.quota", status: 429, message: "balance unavailable", kind: "compaction" as const }
  const fake = createFakePluginContext({
    sessionAgent: "sisyphus",
    sessionInfo: { model },
    sessionMessages: [{ type: "idle", id: "msg_failed", outcome: "failed", error, time: { created: 1 } }],
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const pluginConfig = OhMyOpenCodeConfigSchema.parse({
    agents: { sisyphus: { models: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"] } },
  })
  const runtime = createRuntimeFallbackHook(input, {
    pluginConfig,
    config: { enabled: true, timeout_seconds: 0, notify_on_fallback: false },
  })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(fake.context, hooks)
  if (!installed) throw new Error("Native fallback was not installed")
  try {
    if (source === "retry") {
      const event = {
        sessionID,
        agent: "sisyphus",
        model,
        kind: "compaction" as const,
        error,
        attempt: 3,
        decision: { retry: true as const, delay: 1234 },
      }
      await fake.triggerRetry(event)
      expect(event.decision).toEqual({ retry: true, delay: 1234 })
    } else {
      expect(await installed.beforeEvent({ type: "session.execution.failed", data: { sessionID, error } })).toBe(false)
    }
    expect(fake.sessionCalls).toEqual([])
    expect((await fake.context.session.get({ sessionID })).model).toEqual(model)
  } finally {
    await installed.dispose()
    runtime.dispose?.()
  }
})

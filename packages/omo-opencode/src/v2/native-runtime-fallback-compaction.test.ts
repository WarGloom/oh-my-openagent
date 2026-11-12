import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { createPluginInput } from "./create-plugin-input"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createSessionTracker } from "./session-tracker"

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

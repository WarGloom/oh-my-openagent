import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { startEventBridge } from "./event-bridge"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"

test.each([
  { unsafe: false, chain: true, suppressed: true, delayed: false },
  { unsafe: false, chain: true, suppressed: true, delayed: true },
  { unsafe: true, chain: true, suppressed: false, delayed: true },
  { unsafe: false, chain: false, suppressed: false, delayed: true },
])("watchdog interruption suppresses idle only after accepted recovery: $unsafe / $chain / delayed=$delayed", async ({ unsafe, chain, suppressed, delayed }) => {
  const clock = installRuntimeFallbackTestClock()
  const fake = createFakePluginContext({ sessionAgent: "sisyphus" })
  const ready = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  const model = { providerID: "anthropic", id: "first" }
  const context = { ...fake.context, session: { ...fake.context.session, interrupt: async ({ sessionID }: { sessionID: string; resume?: boolean }) => {
    if (!delayed) fake.emit({ type: "session.execution.interrupted", data: { sessionID, reason: "user" } })
    await fake.context.session.interrupt({ sessionID, resume: false })
  } }, event: { subscribe: async function* (options?: { signal?: AbortSignal }) {
    const stream = fake.context.event.subscribe(options)[Symbol.asyncIterator]()
    let next = stream.next()
    ready.resolve()
    let result = await next
    while (!result.done) { yield result.value; next = stream.next(); result = await next }
  } } }
  const tracker = createSessionTracker()
  const input = createPluginInput(context, { tracker, warn: () => {} })
  const runtime = createRuntimeFallbackHook(input, { pluginConfig: OhMyOpenCodeConfigSchema.parse({ agents: { sisyphus: { models: chain ? ["anthropic/first", "anthropic/second"] : [] } } }), config: { enabled: true, first_progress_timeout_seconds: 1, stall_timeout_seconds: 1, hard_timeout_seconds: 0 } })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(context, hooks)
  if (!installed) throw new Error("Native fallback was not installed")
  const bridge = startEventBridge(context, { tracker, warn: () => {} })
  const seen: Array<{ type: string; sessionID: unknown }> = []
  bridge.setInterceptor(installed.beforeEvent)
  bridge.setHandler(async ({ event }) => {
    seen.push({ type: event.type, sessionID: "sessionID" in event.properties ? event.properties.sessionID : undefined })
    if (event.type === "session.idle" && "sessionID" in event.properties && event.properties.sessionID === "other") drained.resolve()
  })
  try {
    await ready.promise
    await fake.triggerModelRequest({ sessionID: "timed", agent: "sisyphus", model, kind: "primary", headers: {} })
    if (unsafe) await installed.beforeEvent({ type: "session.tool.called", data: { sessionID: "timed", id: "call" } })
    await clock.advanceBy(1_000)
    if (delayed) fake.emit({ type: "session.execution.interrupted", data: { sessionID: "timed", reason: "user" } })
    fake.emit({ type: "session.execution.interrupted", data: { sessionID: "other", reason: "user" } })
    await drained.promise
    expect(seen.filter((event) => event.sessionID === "timed").map((event) => event.type)).toEqual(suppressed ? [] : ["session.error", "session.status", "session.idle"])
    expect(seen.filter((event) => event.sessionID === "other").map((event) => event.type)).toEqual(["session.error", "session.status", "session.idle"])
    expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(suppressed ? 1 : 0)
    expect(await installed.beforeEvent({ type: "session.execution.interrupted", data: { sessionID: "timed", reason: "user" } })).toBe(false)
  } finally {
    bridge.stop()
    await installed.dispose()
    runtime.dispose?.()
    clock.restore()
  }
})

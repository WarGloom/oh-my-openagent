import { afterEach, expect, mock, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { startEventBridge } from "./event-bridge"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createNativeProgressWatchdog } from "./native-progress-watchdog"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function questionFixture() {
  const clock = installRuntimeFallbackTestClock()
  const fake = createFakePluginContext()
  const recover = mock(async () => false)
  const watchdog = createNativeProgressWatchdog({
    context: fake.context,
    timeouts: { firstProgressMs: 1_000, stallMs: 2_000, hardMs: 3_000 },
    recover,
    warn: (error) => {
      throw error
    },
  })
  cleanups.push(clock.restore, () => watchdog.dispose())
  watchdog.start("question", "sisyphus", { providerID: "qa", id: "gpt-fake" })
  const form = (id: string, sessionID = "question") => ({
    type: "form.created",
    data: {
      form: {
        id,
        sessionID,
        title: "Question",
        fields: [],
        metadata: { kind: "question", tool: { id: "call_question", messageID: "msg_question" } },
      },
    },
  })
  return { clock, fake, recover, watchdog, form }
}

test.each([
  { unsafe: false, chain: true, suppressed: true, delayed: false },
  { unsafe: false, chain: true, suppressed: true, delayed: true },
  { unsafe: true, chain: true, suppressed: false, delayed: true },
  { unsafe: false, chain: false, suppressed: false, delayed: true },
])(
  "watchdog interruption suppresses idle only after accepted recovery: $unsafe / $chain / delayed=$delayed",
  async ({ unsafe, chain, suppressed, delayed }) => {
    const clock = installRuntimeFallbackTestClock()
    const fake = createFakePluginContext({ sessionAgent: "sisyphus" })
    const ready = Promise.withResolvers<void>()
    const drained = Promise.withResolvers<void>()
    const model = { providerID: "anthropic", id: "first" }
    const context = {
      ...fake.context,
      experimental: {
        ...fake.context.experimental,
        session: {
          ...fake.context.experimental.session,
          recover: (input: { sessionID: string }, callback: (input: { boundaryID: string }) => Promise<boolean>) =>
            fake.context.experimental.session.recover(input, async (boundary) => {
              if (!delayed)
                fake.emit({
                  type: "session.execution.interrupted",
                  data: { sessionID: input.sessionID, reason: "user" },
                })
              return callback(boundary)
            }),
          interrupt: async ({ sessionID }: { sessionID: string }) => {
            if (!delayed) fake.emit({ type: "session.execution.interrupted", data: { sessionID, reason: "user" } })
            return fake.context.experimental.session.interrupt({ sessionID })
          },
        },
      },
      event: {
        subscribe: async function* (options?: { signal?: AbortSignal }) {
          const stream = fake.context.event.subscribe(options)[Symbol.asyncIterator]()
          let next = stream.next()
          ready.resolve()
          let result = await next
          while (!result.done) {
            yield result.value
            next = stream.next()
            result = await next
          }
        },
      },
    }
    const tracker = createSessionTracker()
    const input = createPluginInput(context, { tracker, warn: () => {} })
    const runtime = createRuntimeFallbackHook(input, {
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        agents: { sisyphus: { models: chain ? ["anthropic/first", "anthropic/second"] : [] } },
      }),
      config: { enabled: true, first_progress_timeout_seconds: 1, stall_timeout_seconds: 1, hard_timeout_seconds: 0 },
    })
    const hooks: Hooks = {}
    bindNativeRuntimeFallback(hooks, runtime)
    const installed = await installNativeRuntimeFallback(context, hooks)
    if (!installed) throw new Error("Native fallback was not installed")
    const bridge = startEventBridge(context, { tracker, warn: () => {} })
    const seen: Array<{ type: string; sessionID: unknown }> = []
    bridge.setInterceptor(installed.beforeEvent)
    bridge.setHandler(async ({ event }) => {
      seen.push({
        type: event.type,
        sessionID: "sessionID" in event.properties ? event.properties.sessionID : undefined,
      })
      if (event.type === "session.idle" && "sessionID" in event.properties && event.properties.sessionID === "other")
        drained.resolve()
    })
    try {
      await ready.promise
      await fake.triggerModelRequest({ sessionID: "timed", agent: "sisyphus", model, kind: "primary", headers: {} })
      if (unsafe) await installed.beforeEvent({ type: "session.tool.called", data: { sessionID: "timed", id: "call" } })
      await clock.advanceBy(1_000)
      if (delayed) fake.emit({ type: "session.execution.interrupted", data: { sessionID: "timed", reason: "user" } })
      fake.emit({ type: "session.execution.interrupted", data: { sessionID: "other", reason: "user" } })
      await drained.promise
      expect(seen.filter((event) => event.sessionID === "timed").map((event) => event.type)).toEqual(
        suppressed ? [] : ["session.error", "session.status", "session.idle"],
      )
      expect(seen.filter((event) => event.sessionID === "other").map((event) => event.type)).toEqual([
        "session.error",
        "session.status",
        "session.idle",
      ])
      expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(suppressed ? 1 : 0)
      expect(
        await installed.beforeEvent({
          type: "session.execution.interrupted",
          data: { sessionID: "timed", reason: "user" },
        }),
      ).toBe(false)
    } finally {
      bridge.stop()
      await installed.dispose()
      runtime.dispose?.()
      clock.restore()
    }
  },
)

test.each([false, true])(
  "a pending native form pauses inactivity and hard timers, then reply rearms the current request (tool=%s)",
  async (tool) => {
    // given
    const f = questionFixture()
    if (tool) f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_question" } })
    // when
    f.watchdog.observe(f.form("form_a"))
    await f.clock.advanceBy(10_000)
    // then
    expect(f.fake.sessionCalls).toEqual([])
    f.watchdog.observe({
      type: "form.replied",
      data: { sessionID: "question", id: "form_a", answer: { q0: "Proceed" } },
    })
    await f.clock.advanceBy(tool ? 1_999 : 999)
    expect(f.fake.sessionCalls).toEqual([])
    await f.clock.advanceBy(1)
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt"])
    expect(f.recover).toHaveBeenCalledTimes(tool ? 0 : 1)
  },
)

test("overlapping forms and permission waits release only their own IDs", async () => {
  // given
  const f = questionFixture()
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_question" } })
  f.watchdog.observe(f.form("a"))
  f.watchdog.observe(f.form("b"))
  f.watchdog.observe(f.form("a"))
  f.watchdog.observe({ type: "permission.asked", data: { sessionID: "question", id: "p" } })
  // when
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "question", id: "a" } })
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "other", id: "b" } })
  f.watchdog.observe({ type: "permission.replied", data: { sessionID: "question", requestID: "unknown" } })
  await f.clock.advanceBy(10_000)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  f.watchdog.observe({ type: "permission.replied", data: { sessionID: "question", requestID: "p" } })
  await f.clock.advanceBy(10_000)
  expect(f.fake.sessionCalls).toEqual([])
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "question", id: "b" } })
  await f.clock.advanceBy(1_000)
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "question", id: "b" } })
  f.watchdog.observe(f.form("a"))
  await f.clock.advanceBy(1_000)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt"])
  expect(f.recover).not.toHaveBeenCalled()
})

test("form cancellation never rearms or replays that request, but a later real request retains its timeout", async () => {
  // given
  const f = questionFixture()
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_question" } })
  f.watchdog.observe(f.form("a"))
  f.watchdog.observe(f.form("b"))
  // when
  f.watchdog.observe({ type: "form.cancelled", data: { sessionID: "question", id: "a" } })
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "question", id: "b" } })
  f.watchdog.observe({ type: "session.tool.updated", data: { sessionID: "question", id: "call_question" } })
  await f.clock.advanceBy(10_000)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  f.watchdog.start("question", "sisyphus", { providerID: "qa", id: "gpt-fake" })
  await f.clock.advanceBy(1_000)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt"])
  expect(f.recover).toHaveBeenCalledTimes(1)
})

test.each([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "dispose",
  "reload",
])("late form events do not resurrect timers after %s", async (terminal) => {
  // given
  const f = questionFixture()
  f.watchdog.observe(f.form("a"))
  // when
  if (terminal === "dispose" || terminal === "reload") f.watchdog.dispose()
  else f.watchdog.observe({ type: terminal, data: { sessionID: "question" } })
  const current =
    terminal === "reload"
      ? createNativeProgressWatchdog({
          context: f.fake.context,
          timeouts: { firstProgressMs: 1_000, stallMs: 2_000, hardMs: 3_000 },
          recover: f.recover,
          warn: (error) => {
            throw error
          },
        })
      : f.watchdog
  cleanups.push(() => current.dispose())
  current.observe(f.form("already_pending"))
  current.observe({ type: "form.replied", data: { sessionID: "question", id: "a" } })
  await f.clock.advanceBy(10_000)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.recover).not.toHaveBeenCalled()
})

test.each(["other", "global"])("a %s form cannot postpone an unrelated model timeout", async (sessionID) => {
  // given
  const f = questionFixture()
  // when
  f.watchdog.observe(f.form("foreign", sessionID))
  await f.clock.advanceBy(1_000)
  // then
  expect(f.fake.sessionCalls).toEqual([{ kind: "interrupt", sessionID: "question" }])
  expect(f.recover).toHaveBeenCalledTimes(1)
})

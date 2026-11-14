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
  const stalledAgain = mock((_sessionID: string) => {})
  const watchdog = createNativeProgressWatchdog({
    context: fake.context,
    timeouts: { firstProgressMs: 1_000, stallMs: 2_000, hardMs: 3_000 },
    recover,
    stalledAgain,
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
  return { clock, fake, recover, stalledAgain, watchdog, form }
}

test("provider backoff pauses both watchdog deadlines and rearms afterward", async () => {
  const f = questionFixture()
  f.watchdog.defer("question", 10_000)
  await f.clock.advanceBy(10_999)
  expect(f.recover).not.toHaveBeenCalled()
  expect(f.fake.sessionCalls).toEqual([])
  await f.clock.advanceBy(1)
  expect(f.recover).toHaveBeenCalledTimes(1)
})

test.each([
  { agent: "sisyphus", unsafe: false, chain: true, suppressed: true, delayed: false },
  { agent: "sisyphus", unsafe: false, chain: true, suppressed: true, delayed: true },
  { agent: "sisyphus", unsafe: true, chain: true, suppressed: true, delayed: true },
  { agent: "sisyphus", unsafe: false, chain: false, suppressed: false, delayed: true },
  { agent: "general", unsafe: false, chain: false, suppressed: false, delayed: true },
])(
  "watchdog interrupts only for a candidate or unsafe tools and suppresses idle only after admission: $agent / $unsafe / $chain / delayed=$delayed",
  async ({ agent, unsafe, chain, suppressed, delayed }) => {
    const clock = installRuntimeFallbackTestClock()
    const fake = createFakePluginContext({ sessionAgent: agent })
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
      await fake.triggerModelRequest({ sessionID: "timed", agent, model, kind: "primary", headers: {} })
      if (unsafe) {
        await installed.beforeEvent({ type: "session.tool.called", data: { sessionID: "timed", id: "call" } })
        await installed.beforeEvent({ type: "session.tool.success", data: { sessionID: "timed", id: "call" } })
      }
      await clock.advanceBy(1_000)
      expect(fake.sessionCalls.filter((call) => call.kind === "interrupt")).toHaveLength(unsafe || chain ? 1 : 0)
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
    if (tool) f.watchdog.observe({ type: "session.tool.success", data: { sessionID: "question", id: "call_question" } })
    await f.clock.advanceBy(tool ? 1_999 : 999)
    expect(f.fake.sessionCalls).toEqual([])
    await f.clock.advanceBy(1)
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(tool ? ["interrupt", "synthetic"] : [])
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
  f.watchdog.observe({ type: "session.tool.success", data: { sessionID: "question", id: "call_question" } })
  await f.clock.advanceBy(1_000)
  f.watchdog.observe({ type: "form.replied", data: { sessionID: "question", id: "b" } })
  f.watchdog.observe(f.form("a"))
  await f.clock.advanceBy(1_000)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "synthetic"])
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
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual([])
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
          stalledAgain: f.stalledAgain,
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
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.recover).toHaveBeenCalledTimes(1)
})

test("a running tool pauses both watchdog deadlines until it settles", async () => {
  // given: the request called a tool, such as a foreground task, that runs far past every deadline
  const f = questionFixture()
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_task" } })
  // when: the tool runs without any further session event
  await f.clock.advanceBy(3_600_000)
  // then: neither an interrupt nor a fallback happens
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.recover).not.toHaveBeenCalled()
  // when: the tool settles and the model then stalls
  f.watchdog.observe({ type: "session.tool.success", data: { sessionID: "question", id: "call_task" } })
  await f.clock.advanceBy(1_999)
  expect(f.fake.sessionCalls).toEqual([])
  await f.clock.advanceBy(1)
  // then: the stall deadline applies again and cannot replay the executed tool
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "synthetic"])
  expect(f.recover).not.toHaveBeenCalled()
})

test("a provider-executed tool does not pause the stall deadline", async () => {
  const f = questionFixture()
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "hosted", executed: true } })
  await f.clock.advanceBy(2_000)
  expect(f.fake.sessionCalls.length).toBeGreaterThan(0)
})

test("parallel tools keep the deadlines paused until the last one settles", async () => {
  // given
  const f = questionFixture()
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_a" } })
  f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call_b" } })
  // when: one tool settles and progress events arrive for the other
  f.watchdog.observe({ type: "session.tool.success", data: { sessionID: "question", id: "call_a" } })
  f.watchdog.observe({ type: "session.tool.progress", data: { sessionID: "question", id: "call_b" } })
  await f.clock.advanceBy(3_600_000)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  f.watchdog.observe({ type: "session.tool.failed", data: { sessionID: "question", id: "call_b" } })
  await f.clock.advanceBy(2_000)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "synthetic"])
})

test("a stall after an executed tool resumes the session once per turn and reports the second stall", async () => {
  // given: a request that ran a tool and then stalls
  const f = questionFixture()
  const stallAfterTool = async () => {
    f.watchdog.observe({ type: "session.tool.called", data: { sessionID: "question", id: "call" } })
    f.watchdog.observe({ type: "session.tool.success", data: { sessionID: "question", id: "call" } })
    await f.clock.advanceBy(2_000)
  }
  const nextRun = async () => {
    f.watchdog.observe({ type: "session.execution.started", data: { sessionID: "question" } })
    f.watchdog.start("question", "sisyphus", { providerID: "qa", id: "gpt-fake" })
    await f.fake.triggerModelRequest({ sessionID: "question", agent: "sisyphus", model: { providerID: "qa", id: "gpt-fake" }, kind: "primary", headers: {} })
  }
  // when: the first stall expires
  await stallAfterTool()
  // then: the session is interrupted and resumed, and its interruption is not shown as a user abort
  expect(f.fake.sessionCalls).toEqual([
    { kind: "interrupt", sessionID: "question" },
    { kind: "synthetic", input: expect.objectContaining({ sessionID: "question", delivery: "steer", resume: true }) },
  ])
  expect(
    await f.watchdog.observe({ type: "session.execution.interrupted", data: { sessionID: "question", reason: "user" } }),
  ).toBe(true)
  // when: the resumed run stalls again
  await nextRun()
  await stallAfterTool()
  // then: it is interrupted without another resume and the stall is reported
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "synthetic", "interrupt"])
  expect(f.stalledAgain).toHaveBeenCalledTimes(1)
  expect(
    f.watchdog.observe({ type: "session.execution.interrupted", data: { sessionID: "question", reason: "user" } }),
  ).toBeUndefined()
  // when: the user starts a new turn and it stalls
  await nextRun()
  await stallAfterTool()
  // then: the new turn has its own resume
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual([
    "interrupt",
    "synthetic",
    "interrupt",
    "interrupt",
    "synthetic",
  ])
  expect(f.recover).not.toHaveBeenCalled()
})

test("a child resumes through a held recovery boundary without cancelling its job", async () => {
  const clock = installRuntimeFallbackTestClock()
  const fake = createFakePluginContext({ sessionInfo: { parentID: "parent" } })
  let cancelled = false
  let repeatedStalls = 0
  const continuations: Array<{ boundaryID: string; id: string; model?: unknown }> = []
  const context = {
    ...fake.context,
    experimental: { ...fake.context.experimental, session: {
      ...fake.context.experimental.session,
      interrupt: async () => { cancelled = true; return { interrupted: true } },
      recover: async (_input: { sessionID: string }, callback: (input: { boundaryID: string }) => Promise<boolean>) =>
        callback({ boundaryID: "msg_boundary" }),
      continueAfterFailure: async (input: { boundaryID: string; id: string; model?: unknown }) => {
        continuations.push(input)
        watchdog.observe({ type: "session.execution.started", data: { sessionID: "child" } })
        watchdog.start("child", "sisyphus", { providerID: "qa", id: "model" })
        return "admitted" as const
      },
    } },
  }
  const watchdog = createNativeProgressWatchdog({
    context, timeouts: { firstProgressMs: 1000, stallMs: 2000, hardMs: 0 },
    recover: async () => false, stalledAgain: () => { repeatedStalls++ }, warn: (error) => { throw error },
  })
  cleanups.push(clock.restore, () => watchdog.dispose())
  watchdog.start("child", "sisyphus", { providerID: "qa", id: "model" })
  watchdog.observe({ type: "session.tool.called", data: { sessionID: "child", id: "tool" } })
  watchdog.observe({ type: "session.tool.success", data: { sessionID: "child", id: "tool" } })
  await clock.advanceBy(2000)
  expect(cancelled).toBe(false)
  expect(continuations).toEqual([expect.objectContaining({ boundaryID: "msg_boundary", id: expect.stringMatching(/^msg_[0-9a-f]{26}$/) })])
  expect(continuations[0]?.model).toBeUndefined()
  watchdog.observe({ type: "session.tool.called", data: { sessionID: "child", id: "tool2" } })
  watchdog.observe({ type: "session.tool.success", data: { sessionID: "child", id: "tool2" } })
  await clock.advanceBy(2000)
  expect(cancelled).toBe(true)
  expect(repeatedStalls).toBe(1)
  expect(continuations).toHaveLength(1)
})

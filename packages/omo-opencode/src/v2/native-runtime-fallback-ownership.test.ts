import { afterEach, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"
import { createPluginInput } from "./create-plugin-input"
import type { V2PluginContext, V2SessionMessage } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createSessionTracker } from "./session-tracker"

const first = { providerID: "anthropic", id: "first" }
const error = { type: "provider.rate-limit", message: "Rate limit reached", status: 429 }
const cleanups: Array<() => void | Promise<void>> = []
let nextSession = 0

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const sessionID = `ses_native_recovery_${++nextSession}`
  const history: V2SessionMessage[] = [
    { type: "idle", id: `${sessionID}_failed`, outcome: "failed", error, time: { created: 1 } },
  ]
  const fake = createFakePluginContext({
    directory: "/work/recovery-owner",
    sessionAgent: "sisyphus",
    sessionInfo: { model: first },
    sessionMessages: history,
  })
  const event = { type: "session.execution.failed", data: { sessionID, error } }
  return { fake, history: fake.sessionHistory(sessionID), sessionID, event }
}

async function observer(
  context: V2PluginContext,
  sessionID: string,
  config: {
    readonly max_fallback_attempts?: number
    readonly restore_primary_after_cooldown?: boolean
    readonly first_progress_timeout_seconds?: number
  } = {},
) {
  const input = createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} })
  const runtime = createRuntimeFallbackHook(input, {
    pluginConfig: OhMyOpenCodeConfigSchema.parse({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third"] } },
    }),
    config: { enabled: true, timeout_seconds: 0, notify_on_fallback: false, cooldown_seconds: 1, ...config },
  })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(context, hooks)
  if (!installed) throw new Error("Native recovery was not installed")
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await installed.dispose()
    runtime.dispose?.()
  }
  cleanups.push(async () => {
    runtime.native?.forget(sessionID)
    await dispose()
  })
  return { installed, dispose }
}

test("only the session Location recovers a failure observed by several plugin instances", async () => {
  // given
  const f = fixture()
  const observers = await Promise.all(
    ["/work/other-a", "/work/other-b", "/work/recovery-owner", "/work/other-c"].map((directory) =>
      observer({ ...f.fake.context, location: { ...f.fake.context.location, directory } }, f.sessionID),
    ),
  )
  // when
  await Promise.all(observers.map(({ installed }) => installed.beforeEvent(f.event)))
  // then
  expect((await f.fake.context.session.get({ sessionID: f.sessionID })).model).toEqual({
    providerID: "anthropic",
    id: "second",
    variant: undefined,
  })
  expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
  expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(1)
})

test("concurrent observers share one failure reservation without exposing a legacy retry", async () => {
  // given
  const f = fixture()
  const observers = await Promise.all([observer(f.fake.context, f.sessionID), observer(f.fake.context, f.sessionID)])
  // when
  const results = await Promise.all(
    observers.flatMap(({ installed }) => [installed.beforeEvent(f.event), installed.beforeEvent(f.event)]),
  )
  // then
  expect(results).toEqual([true, true, true, true])
  expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
  expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(1)
})

test.each(["succeeded", "interrupted"] as const)(
  "does not recover a stale failure after the session %s",
  async (outcome) => {
    // given
    const f = fixture()
    f.history.splice(0, 1, { type: "idle", id: `${f.sessionID}_later`, outcome, time: { created: 2 } })
    const { installed } = await observer(f.fake.context, f.sessionID)
    // when
    await installed.beforeEvent(f.event)
    // then
    expect(f.fake.sessionCalls).toEqual([])
  },
)

test.each(["interrupted", "user input"] as const)(
  "a session that moves past the failure (%s) while recovery awaits host models gets no switch or resume",
  async (move) => {
    // given: recovery is suspended inside its async gap, after the failed-boundary check
    const f = fixture()
    const listing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const context = {
      ...f.fake.context,
      model: {
        ...f.fake.context.model,
        list: async () => {
          listing.resolve()
          await release.promise
          return f.fake.context.model.list()
        },
      },
    }
    const { installed } = await observer(context, f.sessionID)
    const recovering = installed.beforeEvent(f.event)
    await listing.promise
    // when: the session advances before recovery resumes
    f.history.push(
      move === "interrupted"
        ? { type: "idle", id: `${f.sessionID}_interrupted`, outcome: "interrupted", time: { created: 2 } }
        : { type: "user", id: `${f.sessionID}_user`, text: "new direction", time: { created: 2 } },
    )
    release.resolve()
    await recovering
    // then
    expect(f.fake.sessionCalls).toEqual([])
    expect((await f.fake.context.session.get({ sessionID: f.sessionID })).model).toEqual(first)
  },
)

test.each(["user input", "new execution"] as const)(
  "a session that moves past the watchdog abort (%s) while timeout recovery awaits host models gets no switch or resume",
  async (move) => {
    // given: the watchdog aborted a stalled request, and its recovery is suspended inside the async gap
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture()
    const listing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const context = {
      ...f.fake.context,
      model: {
        ...f.fake.context.model,
        list: async () => {
          listing.resolve()
          await release.promise
          return f.fake.context.model.list()
        },
      },
    }
    await observer(context, f.sessionID, { first_progress_timeout_seconds: 1 })
    await f.fake.triggerModelRequest({
      sessionID: f.sessionID,
      agent: "sisyphus",
      model: first,
      kind: "primary",
      headers: {},
    })
    const expiring = clock.advanceBy(1_000)
    await listing.promise
    // when: the session advances before recovery resumes
    f.history.push(
      move === "user input"
        ? { type: "user", id: `${f.sessionID}_user`, text: "new direction", time: { created: 2 } }
        : { type: "idle", id: `${f.sessionID}_next`, outcome: "succeeded", time: { created: 2 } },
    )
    release.resolve()
    await expiring
    // then
    expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel" || call.kind === "synthetic")).toEqual([])
    expect((await f.fake.context.session.get({ sessionID: f.sessionID })).model).toEqual(first)
  },
)

test("a disposed observer cannot switch models or admit a recovery", async () => {
  // given
  const f = fixture()
  const current = await observer(f.fake.context, f.sessionID)
  await current.dispose()
  // when
  await current.installed.beforeEvent(f.event)
  // then
  expect(f.fake.sessionCalls).toEqual([])
})

test("reload does not lose a failure reserved while its history read is pending", async () => {
  // given
  const f = fixture()
  const reading = Promise.withResolvers<void>()
  const joining = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  const context = {
    ...f.fake.context,
    session: {
      ...f.fake.context.session,
      context: async () => {
        if (++reads === 2) {
          reading.resolve()
          await release.promise
        }
        if (reads === 3) joining.resolve()
        return f.history
      },
    },
  }
  const previous = await observer(context, f.sessionID)
  const recovering = previous.installed.beforeEvent(f.event)
  await reading.promise
  // when
  await previous.dispose()
  const next = await observer(context, f.sessionID)
  const resumed = next.installed.beforeEvent(f.event)
  await joining.promise
  release.resolve()
  await Promise.all([recovering, resumed])
  // then
  expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(1)
  expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
})

test("plugin reload retains the fallback budget for a later distinct failure", async () => {
  // given
  const f = fixture()
  const old = await observer(f.fake.context, f.sessionID, { max_fallback_attempts: 1 })
  await old.installed.beforeEvent(f.event)
  await old.dispose()
  f.history.splice(0, 1, {
    type: "idle",
    id: `${f.sessionID}_next_failure`,
    outcome: "failed",
    error,
    time: { created: 3 },
  })
  const current = await observer(f.fake.context, f.sessionID, { max_fallback_attempts: 1 })
  // when
  await current.installed.beforeEvent(f.event)
  // then
  expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(1)
  expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
})

test.each([undefined, "high"])(
  "a later explicit prompt restores the primary and variant after cooldown (%s)",
  async (variant) => {
    // given
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture()
    if (variant) await f.fake.context.session.switchModel({ sessionID: f.sessionID, model: { ...first, variant } })
    const current = await observer(f.fake.context, f.sessionID, { restore_primary_after_cooldown: true })
    await current.installed.beforeEvent(f.event)
    await clock.advanceBy(1_000)
    // when
    await f.fake.triggerPrompt({
      sessionID: f.sessionID,
      messageID: `${f.sessionID}_user_next`,
      prompt: { text: "Continue" },
    })
    // then
    expect((await f.fake.context.session.get({ sessionID: f.sessionID })).model).toEqual({ ...first, variant })
  },
)

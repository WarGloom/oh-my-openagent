import { afterEach, expect, spyOn, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"
import { getNativeFallbackModel } from "../hooks/runtime-fallback/native-controller"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { isNativeRecoveryPending } from "./native-recovery-state"
import type { V2PluginContext, V2RetryHookEvent } from "./context-types"

const cleanups: Array<() => void | Promise<void>> = []
let serial = 0
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const first = { providerID: "anthropic", id: "first" }
const error = { type: "provider.quota", message: "balance unavailable" }

async function fixture(
  options: {
    readonly variant?: string
    readonly watchdog?: boolean
    readonly maxAttempts?: number
    readonly admission?: V2PluginContext["experimental"]["session"]["continueAfterFailure"]
  } = {},
) {
  const sessionID = `ses_atomic_${++serial}`
  const boundaryID = `msg_failure_${serial}`
  const fake = createFakePluginContext({
    sessionAgent: "sisyphus",
    sessionInfo: { model: { ...first, variant: options.variant } },
    sessionMessages: [{ type: "idle", id: boundaryID, outcome: "failed", error, time: { created: 1 } }],
  })
  const toasts: unknown[] = []
  const context = options.admission
    ? {
        ...fake.context,
        experimental: {
          ...fake.context.experimental,
          session: { ...fake.context.experimental.session, continueAfterFailure: options.admission },
        },
      }
    : fake.context
  const input = createPluginInput(context, {
    tracker: createSessionTracker(),
    warn: () => {},
    emitToast: async (toast) => {
      toasts.push(toast)
    },
  })
  const runtime = createRuntimeFallbackHook(input, {
    pluginConfig: OhMyOpenCodeConfigSchema.parse({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third"] } },
    }),
    config: {
      enabled: true,
      timeout_seconds: 0,
      first_progress_timeout_seconds: options.watchdog ? 1 : 0,
      max_fallback_attempts: options.maxAttempts ?? 2,
      cooldown_seconds: 1,
      restore_primary_after_cooldown: true,
      notify_on_fallback: true,
    },
  })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(context, hooks)
  if (!installed) throw new Error("Native recovery not installed")
  cleanups.push(async () => {
    runtime.native?.forget(sessionID)
    await installed.dispose()
    runtime.dispose?.()
  })
  const retry = (model: V2RetryHookEvent["model"]) =>
    fake.triggerRetry({ sessionID, agent: "sisyphus", model, attempt: 3, error, decision: { retry: false } })
  return { fake, context, installed, sessionID, boundaryID, toasts, retry, hooks }
}

test("projected default variant retains cooldown state and selects the next fallback", async () => {
  // given
  const f = await fixture({ variant: "default" })
  await f.retry({ ...first, variant: "default" })
  await f.fake.context.session.switchModel({
    sessionID: f.sessionID,
    model: { providerID: "anthropic", id: "second", variant: "default" },
  })
  // when
  await f.fake.triggerPrompt({ sessionID: f.sessionID, messageID: "msg_next", prompt: { text: "Continue" } })
  await f.retry({ providerID: "anthropic", id: "second", variant: "default" })
  // then
  expect((await f.context.session.get({ sessionID: f.sessionID })).model).toEqual({
    providerID: "anthropic",
    id: "third",
    variant: undefined,
  })
})

test.each([undefined, "default", "high"])(
  "cooldown restoration preserves the original primary variant %s",
  async (variant) => {
    // given
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = await fixture({ variant })
    await f.retry({ ...first, variant })
    await f.fake.context.session.switchModel({
      sessionID: f.sessionID,
      model: { providerID: "anthropic", id: "second", variant: "default" },
    })
    await clock.advanceBy(1_000)
    // when
    await f.fake.triggerPrompt({ sessionID: f.sessionID, messageID: "msg_next", prompt: { text: "Continue" } })
    // then
    expect((await f.context.session.get({ sessionID: f.sessionID })).model).toEqual({
      ...first,
      variant: variant === "default" ? undefined : variant,
    })
  },
)

test("duplicate atomic admission emits no toast and consumes no fallback budget", async () => {
  // given
  let admission: "duplicate" | "admitted" = "duplicate"
  const f = await fixture({ maxAttempts: 1, admission: async () => admission })
  const event = { type: "session.execution.failed", data: { sessionID: f.sessionID, error } }
  // when
  expect(await f.installed.beforeEvent(event)).toBe(true)
  // then
  expect(f.toasts).toEqual([])
  expect(getNativeFallbackModel(f.sessionID)).toBeUndefined()
  expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
  admission = "admitted"
  f.fake
    .sessionHistory(f.sessionID)
    .push({ type: "idle", id: "msg_distinct", outcome: "failed", error, time: { created: 2 } })
  await f.installed.beforeEvent(event)
  expect(getNativeFallbackModel(f.sessionID)?.model).toEqual({ providerID: "anthropic", modelID: "second" })
  expect(f.toasts).toHaveLength(1)
})

test.each(["prompt", "interrupt"] as const)(
  "terminal admission refuses a boundary superseded by %s during model lookup",
  async (move) => {
    // given
    const f = await fixture()
    const listing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = f.context.model.list
    using lookup = spyOn(f.context.model, "list").mockImplementation(async () => {
      listing.resolve()
      await release.promise
      return original()
    })
    const recovering = f.installed.beforeEvent({
      type: "session.execution.failed",
      data: { sessionID: f.sessionID, error },
    })
    await listing.promise
    // when
    if (move === "prompt")
      await f.context.session.prompt({ sessionID: f.sessionID, text: "New direction", resume: false })
    else await f.context.session.interrupt({ sessionID: f.sessionID })
    release.resolve()
    await recovering
    // then
    expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel" || call.kind === "synthetic")).toEqual([])
    expect(f.toasts).toEqual([])
    expect(getNativeFallbackModel(f.sessionID)).toBeUndefined()
    expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
    lookup.mockRestore()
    await f.fake.triggerModelRequest({
      sessionID: f.sessionID,
      agent: "sisyphus",
      model: first,
      kind: "primary",
      headers: {},
    })
    f.fake
      .sessionHistory(f.sessionID)
      .push({ type: "idle", id: "msg_distinct", outcome: "failed", error, time: { created: 3 } })
    await f.installed.beforeEvent({ type: "session.execution.failed", data: { sessionID: f.sessionID, error } })
    expect(getNativeFallbackModel(f.sessionID)?.model).toEqual({ providerID: "anthropic", modelID: "second" })
    expect(f.toasts).toHaveLength(1)
  },
)

test("watchdog cannot continue an arbitrary interrupted idle without its own interrupt boundary", async () => {
  // given
  const clock = installRuntimeFallbackTestClock()
  cleanups.push(clock.restore)
  const f = await fixture({ watchdog: true })
  using interrupt = spyOn(f.context.experimental.session, "interrupt").mockResolvedValue({ interrupted: false })
  f.fake
    .sessionHistory(f.sessionID)
    .push({ type: "idle", id: "msg_other_interrupt", outcome: "interrupted", time: { created: 2 } })
  await f.fake.triggerModelRequest({
    sessionID: f.sessionID,
    agent: "sisyphus",
    model: first,
    kind: "primary",
    headers: {},
  })
  // when
  await clock.advanceBy(1_000)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.toasts).toEqual([])
  expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
})

test("a missing terminal boundary leaves recovery available for a later durable failure", async () => {
  // given
  const f = await fixture()
  const history = f.fake.sessionHistory(f.sessionID)
  history.splice(0)
  const event = { type: "session.execution.failed", data: { sessionID: f.sessionID, error } }
  // when
  await f.installed.beforeEvent(event)
  // then
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.toasts).toEqual([])
  expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
  history.push({ type: "idle", id: "msg_later_failure", outcome: "failed", error, time: { created: 2 } })
  await f.installed.beforeEvent(event)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["switchModel", "synthetic"])
  expect(getNativeFallbackModel(f.sessionID)?.model).toEqual({ providerID: "anthropic", modelID: "second" })
})

test("watchdog admits only the exact interrupted boundary produced and journaled by its call", async () => {
  // given
  const clock = installRuntimeFallbackTestClock()
  cleanups.push(clock.restore)
  const f = await fixture({ watchdog: true })
  const admission = spyOn(f.context.experimental.session, "continueAfterFailure")
  cleanups.push(() => admission.mockRestore())
  await f.fake.triggerModelRequest({
    sessionID: f.sessionID,
    agent: "sisyphus",
    model: first,
    kind: "primary",
    headers: {},
  })
  // when
  await clock.advanceBy(1_000)
  // then
  const boundary = f.fake.sessionHistory(f.sessionID).at(-1)
  expect(boundary).toMatchObject({ type: "idle", outcome: "interrupted" })
  expect(boundary?.id).not.toBe(f.boundaryID)
  expect(admission).toHaveBeenCalledTimes(1)
  expect(admission.mock.calls[0]?.[0].boundaryID).toBe(boundary?.id)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "switchModel", "synthetic"])
})

test("watchdog reserves recovery through model lookup and releases a stale admission", async () => {
  // given
  const clock = installRuntimeFallbackTestClock()
  cleanups.push(clock.restore)
  const f = await fixture({ watchdog: true })
  const listing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = f.context.model.list
  using lookup = spyOn(f.context.model, "list").mockImplementation(async () => {
    listing.resolve()
    await release.promise
    return original()
  })
  await f.fake.triggerModelRequest({
    sessionID: f.sessionID,
    agent: "sisyphus",
    model: first,
    kind: "primary",
    headers: {},
  })
  const expiring = clock.advanceBy(1_000)
  await listing.promise
  // when
  try {
    expect(isNativeRecoveryPending(f.sessionID)).toBe(true)
    await f.context.session.prompt({ sessionID: f.sessionID, text: "New direction", resume: false })
  } finally {
    release.resolve()
    await expiring
  }
  // then
  expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel" || call.kind === "synthetic")).toEqual([])
  expect(f.toasts).toEqual([])
  expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
  lookup.mockRestore()
  await f.fake.triggerModelRequest({
    sessionID: f.sessionID,
    agent: "sisyphus",
    model: first,
    kind: "primary",
    headers: {},
  })
  await clock.advanceBy(1_000)
  expect(getNativeFallbackModel(f.sessionID)?.model).toEqual({ providerID: "anthropic", modelID: "second" })
  expect(f.toasts).toHaveLength(1)
})

test("a lost admission acknowledgement is a stable-ID duplicate after reload without another effect or toast", async () => {
  // given
  const f = await fixture()
  const original = f.context.experimental.session.continueAfterFailure
  using admission = spyOn(f.context.experimental.session, "continueAfterFailure").mockImplementationOnce(
    async (input) => {
      await original(input)
      throw new Error("Lost admission acknowledgement")
    },
  )
  using switchModel = spyOn(f.context.session, "switchModel")
  using synthetic = spyOn(f.context.session, "synthetic")
  const event = { type: "session.execution.failed", data: { sessionID: f.sessionID, error } }
  await expect(f.installed.beforeEvent(event)).rejects.toThrow("Lost admission acknowledgement")
  await f.installed.dispose()
  const reloaded = await installNativeRuntimeFallback(f.context, f.hooks)
  if (!reloaded) throw new Error("Native recovery not reinstalled")
  cleanups.push(() => reloaded.dispose())
  // when
  expect(await reloaded.beforeEvent(event)).toBe(true)
  // then
  expect(admission).toHaveBeenCalledTimes(2)
  expect(admission.mock.calls[0]?.[0].id).toBe(admission.mock.calls[1]?.[0].id)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["switchModel", "synthetic"])
  expect(switchModel).not.toHaveBeenCalled()
  expect(synthetic).not.toHaveBeenCalled()
  expect(f.toasts).toEqual([])
  expect(isNativeRecoveryPending(f.sessionID)).toBe(false)
})

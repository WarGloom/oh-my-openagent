import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema, type OhMyOpenCodeConfig } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { getNativeFallbackModel, hasNativeRuntimeFallback } from "../hooks/runtime-fallback/native-controller"
import { toBackgroundTaskSnapshots } from "../features/background-agent/task-snapshot"
import { SessionCategoryRegistry } from "../shared/session-category-registry"
import { tryFallbackRetry } from "../features/background-agent/fallback-retry-handler"
import { ConcurrencyManager } from "../features/background-agent/concurrency"
import type { BackgroundTask } from "../features/background-agent/types"
import { createPluginInput } from "./create-plugin-input"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createSessionTracker } from "./session-tracker"
import { clearAllSessionPromptParams, getSessionPromptParams } from "../shared/session-prompt-params-state"
import type { V2ModelInfo, V2ModelRef, V2RetryHookEvent, V2SessionMessage, V2StructuredError } from "./context-types"
import { installRuntimeFallbackTestClock } from "../hooks/runtime-fallback/test-timeout-clock.test-support"

const first = { providerID: "anthropic", id: "first" }
const second = { providerID: "anthropic", id: "second" }
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  SessionCategoryRegistry.clear()
  clearAllSessionPromptParams()
})

function hostModel(providerID: string, modelID: string): V2ModelInfo {
  return { id: modelID, modelID, providerID, name: modelID, status: "active", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 200000, output: 64000 } }
}

function fixture(config: Partial<OhMyOpenCodeConfig> = { agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } } }, history: readonly V2SessionMessage[] = [], model: V2ModelRef | null = first, models: readonly V2ModelInfo[] = []) {
  const fake = createFakePluginContext({ sessionAgent: "sisyphus", sessionInfo: { model: model ?? undefined }, sessionMessages: history, models })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const runtime = createRuntimeFallbackHook(input, { pluginConfig: OhMyOpenCodeConfigSchema.parse(config), config: { enabled: true, max_fallback_attempts: 2, timeout_seconds: 0, notify_on_fallback: false, ...(typeof config.runtime_fallback === "object" ? config.runtime_fallback : {}) } })
  cleanups.push(() => runtime.dispose?.())
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  return { fake, input, runtime, hooks }
}

function retry(error: V2StructuredError, overrides: Partial<V2RetryHookEvent> = {}): V2RetryHookEvent {
  return { sessionID: "ses_main", agent: "Sisyphus", model: first, attempt: 2, decision: { retry: false }, error, ...overrides }
}

async function install(f: ReturnType<typeof fixture>) {
  const installed = await installNativeRuntimeFallback(f.fake.context, f.hooks)
  if (!installed) throw new Error("Native fallback was not installed")
  cleanups.push(() => installed.dispose())
  return installed
}

describe("native runtime fallback", () => {
  test("uses configured first-progress and stall limits to interrupt and resume with a native fallback", async () => {
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } }, runtime_fallback: { first_progress_timeout_seconds: 2, stall_timeout_seconds: 4 } })
    const installed = await install(f)
    await f.fake.triggerModelRequest({ sessionID: "ses_main", agent: "sisyphus", model: first, kind: "primary", headers: {} })
    await clock.advanceBy(1_999)
    expect(f.fake.sessionCalls).toEqual([])
    await installed.beforeEvent({ type: "session.reasoning.delta", data: { sessionID: "ses_main", delta: "thinking" } })
    await clock.advanceBy(3_999)
    expect(f.fake.sessionCalls).toEqual([])
    await clock.advanceBy(1)
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "switchModel", "synthetic"])
    expect(getNativeFallbackModel("ses_main")?.model).toEqual({ providerID: "anthropic", modelID: "second" })
  })

  test("times out a request with no progress but never replays stalled tools or permission waits", async () => {
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } }, runtime_fallback: { first_progress_timeout_seconds: 2, stall_timeout_seconds: 4 } })
    const installed = await install(f)
    const request = { sessionID: "ses_main", agent: "sisyphus", model: first, kind: "primary" as const, headers: {} }
    await f.fake.triggerModelRequest(request)
    await clock.advanceBy(2_000)
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["interrupt", "switchModel", "synthetic"])
    await f.fake.triggerModelRequest({ ...request, sessionID: "tool" })
    await installed.beforeEvent({ type: "session.tool.called", data: { sessionID: "tool", id: "call" } })
    await clock.advanceBy(4_000)
    expect(f.fake.sessionCalls.at(-1)).toEqual({ kind: "interrupt", sessionID: "tool" })
    expect(f.fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
    await f.fake.triggerModelRequest({ ...request, sessionID: "permission" })
    await installed.beforeEvent({ type: "permission.asked", data: { sessionID: "permission", id: "per" } })
    await clock.advanceBy(10_000)
    expect(f.fake.sessionCalls).toHaveLength(4)
    await installed.beforeEvent({ type: "permission.replied", data: { sessionID: "permission", requestID: "per" } })
    await installed.dispose()
    await clock.advanceBy(10_000)
    expect(f.fake.sessionCalls).toHaveLength(4)
  })
  test.each([
    { type: "provider.rate-limit", message: "slow down", status: 429 },
    { type: "provider.auth", message: "no credential" },
    { type: "provider.quota", message: "balance unavailable" },
    { type: "provider.content-filter", message: "response blocked" },
  ])("switches before native retry for $type without another user prompt", async (error) => {
    // given
    const f = fixture()
    await install(f)
    // when
    const event = await f.fake.triggerRetry(retry(error))
    // then
    expect(event.decision).toEqual({ retry: true, delay: 0 })
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } }])
  })

  test.each([
    { type: "provider.invalid-request", message: "invalid argument", status: 400 },
    { type: "permission.rejected", message: "access denied" },
    { type: "unknown", message: "model tried to call unavailable tool" },
    { type: "unknown", message: "context length exceeded" },
  ])("preserves the native decision for non-fallback $type", async (error) => {
    // given
    const f = fixture()
    await install(f)
    const event = retry(error, { decision: { retry: true, delay: 4567 } })
    const decision = event.decision
    // when
    await f.fake.triggerRetry(event)
    // then
    expect(event.decision).toBe(decision)
    expect(f.fake.sessionCalls).toEqual([])
  })

  test("uses the delegated session category chain and variant instead of the main agent chain", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "anthropic/wrong"] } }, categories: { quick: { models: ["anthropic/first", "anthropic/second(high)"] } } })
    SessionCategoryRegistry.register("ses_child", "quick")
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }, { sessionID: "ses_child" }))
    // then
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_child", model: { ...second, variant: "high" } }])
  })

  test("keeps a chain entry's own reasoning after fallback", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { reasoning: "low", models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }] } } })
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_main", model: { providerID: "anthropic", id: "claude-sonnet-4-6", variant: "high" } }])
  })

  test("sends a chain entry's reasoning as request options when the model has no matching variant", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", { model: "anthropic/second", reasoning: "high", temperature: 0.2 }] } } })
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } }])
    expect(getSessionPromptParams("ses_main")).toMatchObject({ temperature: 0.2, options: { reasoningEffort: "high" } })
  })

  test("drops a variant the host model does not offer instead of failing the retry", async () => {
    // given
    const sonnet = hostModel("anthropic", "claude-sonnet-4-6")
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }] } } }, [], first, [hostModel("anthropic", "first"), { ...sonnet, variants: [{ id: "low" }] }])
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_main", model: { providerID: "anthropic", id: "claude-sonnet-4-6", variant: undefined } }])
  })

  test("reports the model and effort that native fallback applied in the job snapshot", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }] } } }, [], first, [hostModel("anthropic", "first"), { ...hostModel("anthropic", "claude-sonnet-4-6"), variants: [{ id: "high" }] }])
    const installed = await install(f)
    const task: BackgroundTask = { id: "task_snapshot", sessionId: "ses_snapshot", parentSessionId: "ses_parent", parentMessageId: "msg_parent", agent: "sisyphus", prompt: "child", description: "child", status: "running", model: { providerID: "anthropic", modelID: "first", variant: "low" } }
    cleanups.push(() => installed.beforeEvent({ type: "session.deleted", data: { sessionID: "ses_snapshot" } }).then(() => {}))
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }, { sessionID: "ses_snapshot" }))
    // then
    expect(getNativeFallbackModel("ses_snapshot")).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" }, variant: "high" })
    expect(toBackgroundTaskSnapshots([task])[0]).toMatchObject({ model: "claude-sonnet-4-6", reasoningEffort: "high" })
  })

  test("skips a chain entry whose provider the host does not serve", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "missing/model", "anthropic/second"] } } }, [], first, [hostModel("anthropic", "first"), hostModel("anthropic", "second")])
    await install(f)
    // when
    const event = await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(event.decision).toEqual({ retry: true, delay: 0 })
    expect(f.fake.sessionCalls).toEqual([{ kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } }])
  })

  test("advances shared state once per failure and stops at chain exhaustion", async () => {
    // given
    const f = fixture()
    await install(f)
    const error = { type: "provider.rate-limit", message: "rate limit", status: 429 }
    await f.fake.triggerRetry(retry(error))
    // when
    const exhausted = await f.fake.triggerRetry(retry(error, { model: second, attempt: 3, decision: { retry: false } }))
    // then
    expect(exhausted.decision).toEqual({ retry: false })
    expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(1)
  })

  test("rolls back selection when a durable model switch fails", async () => {
    // given
    const f = fixture()
    const original = f.fake.context.session.switchModel
    let fail = true
    const context = { ...f.fake.context, session: { ...f.fake.context.session, switchModel: async (input: Parameters<typeof original>[0]) => {
      if (fail) throw new Error("switch failed")
      await original(input)
    } } }
    const installed = await installNativeRuntimeFallback(context, f.hooks)
    cleanups.push(() => installed?.dispose())
    await expect(f.fake.triggerRetry(retry({ type: "provider.auth", message: "no credential" }))).rejects.toThrow("switch failed")
    fail = false
    // when
    await f.fake.triggerRetry(retry({ type: "provider.auth", message: "no credential" }))
    // then
    expect((await context.session.get({ sessionID: "ses_main" })).model).toEqual({ ...second, variant: undefined })
  })

  test("respects the shared maximum fallback attempt count", async () => {
    // given
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third", "anthropic/fourth"] } } })
    await install(f)
    const error = { type: "provider.auth", message: "no credential" }
    await f.fake.triggerRetry(retry(error))
    await f.fake.triggerRetry(retry(error, { model: second, attempt: 3 }))
    // when
    await f.fake.triggerRetry(retry(error, { model: { providerID: "anthropic", id: "third" }, attempt: 4 }))
    // then
    expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(2)
  })

  test("prevents a task-owned V1 retry from replaying a native-owned child prompt", async () => {
    // given
    const f = fixture()
    await install(f)
    const task: BackgroundTask = { id: "task_1", sessionId: "ses_child", parentSessionId: "ses_parent", parentMessageId: "msg_parent", agent: "sisyphus", prompt: "original child request", description: "child", status: "running", attemptCount: 0, fallbackChain: [{ model: "second", providers: ["anthropic"] }], model: { providerID: "anthropic", modelID: "first" } }
    // when
    const handled = await tryFallbackRetry({ task, client: f.input.client, errorInfo: { statusCode: 429, message: "rate limit" }, source: "session.error", concurrencyManager: new ConcurrencyManager(), idleDeferralTimers: new Map(), queuesByKey: new Map(), processKey: () => {}, deps: { readConnectedProvidersCache: () => null, readProviderModelsCache: () => null } })
    // then
    expect(handled).toBe(false)
    expect(task.status).toBe("running")
    expect(f.fake.sessionCalls).toEqual([])
  })

  test("recovers preparation failure with one idempotent synthetic continuation", async () => {
    // given
    const error = { type: "provider.no-route", message: "Model unavailable" }
    const history: V2SessionMessage[] = [{ type: "user", id: "msg_user", text: "original task", time: { created: 1 } }, { type: "idle", id: "msg_failure", outcome: "failed", error, time: { created: 2 } }]
    const f = fixture(undefined, history)
    const installed = await install(f)
    const event = { type: "session.execution.failed", data: { sessionID: "ses_main", error } }
    // when
    const consumed = await installed.beforeEvent(event)
    const replayConsumed = await installed.beforeEvent(event)
    // then
    expect([consumed, replayConsumed]).toEqual([true, true])
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["switchModel", "synthetic"])
    const continuation = f.fake.sessionCalls.find((call) => call.kind === "synthetic")
    expect(continuation?.input).toMatchObject({ sessionID: "ses_main", resume: true, delivery: "steer" })
    expect(continuation?.input.id).toBeUndefined()
  })

  test("keeps recovered failures away from legacy error and idle consumers through real setup", async () => {
    // given
    const error = { type: "provider.auth", message: "no credential" }
    const f = fixture(undefined, [{ type: "idle", id: "msg_failed", outcome: "failed", error, time: { created: 1 } }])
    const barrier = Promise.withResolvers<void>()
    const events: string[] = []
    f.hooks.event = async ({ event }) => {
      events.push(event.type)
      if (event.type === "session.created") barrier.resolve()
    }
    const cleanup = await createV2Setup({ serverPlugin: async () => f.hooks, warn: (message) => { throw new Error(message) } })(f.fake.context)
    cleanups.push(cleanup)
    // when
    f.fake.emit({ type: "session.execution.failed", data: { sessionID: "ses_main", error } })
    f.fake.emit({ type: "session.created", data: { sessionID: "ses_barrier" } })
    await barrier.promise
    // then
    expect(events).toEqual(["session.created"])
    expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(["switchModel", "synthetic"])
  })

  test("bootstraps an inherited agent model when preparation fails before a model is selected", async () => {
    // given
    const error = { type: "provider.no-route", message: "No model is available" }
    const f = fixture(undefined, [{ type: "idle", id: "msg_failed", outcome: "failed", error, time: { created: 1 } }], null)
    const installed = await install(f)
    // when
    const recovered = await installed.beforeEvent({ type: "session.execution.failed", data: { sessionID: "ses_main", error } })
    // then
    expect(recovered).toBe(true)
    expect((await f.fake.context.session.get({ sessionID: "ses_main" })).model).toEqual({ ...second, variant: undefined })
  })

  test("releases native ownership and retry hooks when disposed", async () => {
    // given
    const f = fixture()
    const installed = await install(f)
    expect(hasNativeRuntimeFallback(f.input.client)).toBe(true)
    // when
    await installed.dispose()
    // then
    expect(hasNativeRuntimeFallback(f.input.client)).toBe(false)
    expect(f.fake.sessionHookCount()).toBe(0)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema, type OhMyOpenCodeConfig } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import {
  getNativeFallbackModel,
  getNativeUnavailableModels,
  hasNativeRuntimeFallback,
} from "../hooks/runtime-fallback/native-controller"
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
import type {
  V2HttpResponseHookEvent,
  V2ModelInfo,
  V2ModelRef,
  V2RetryHookEvent,
  V2SessionMessage,
  V2StructuredError,
} from "./context-types"
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
  return {
    id: modelID,
    modelID,
    providerID,
    name: modelID,
    status: "active",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    limit: { context: 200000, output: 64000 },
  }
}

function fixture(
  config: Partial<OhMyOpenCodeConfig> = { agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } } },
  history: readonly V2SessionMessage[] = [],
  model: V2ModelRef | null = first,
  models: readonly V2ModelInfo[] = [],
) {
  let connection: string | undefined = "a"
  let failConnection = false
  const fake = createFakePluginContext({
    sessionAgent: "sisyphus",
    sessionInfo: { model: model ?? undefined },
    sessionMessages: history,
    models,
    providers: [{ id: "anthropic", name: "anthropic", activation: "enabled", integrationID: "custom-anthropic" }],
    activeConnection: async (id) => {
      if (id !== "custom-anthropic") return undefined
      if (failConnection) throw new Error("connection unavailable")
      return connection === undefined ? undefined : { type: "credential", id: connection }
    },
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const runtime = createRuntimeFallbackHook(input, {
    pluginConfig: OhMyOpenCodeConfigSchema.parse(config),
    config: {
      enabled: true,
      max_fallback_attempts: 2,
      timeout_seconds: 0,
      notify_on_fallback: false,
      ...(typeof config.runtime_fallback === "object" ? config.runtime_fallback : {}),
    },
  })
  cleanups.push(() => {
    for (const call of fake.sessionCalls) {
      if ("sessionID" in call) runtime.native?.forget(call.sessionID)
    }
    runtime.dispose?.()
  })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  return {
    fake,
    input,
    runtime,
    hooks,
    setConnection: (id: string | undefined) => {
      connection = id
    },
    setConnectionFailure: (value: boolean) => {
      failConnection = value
    },
  }
}

function retry(error: V2StructuredError, overrides: Partial<V2RetryHookEvent> = {}): V2RetryHookEvent {
  return {
    sessionID: "ses_main",
    agent: "Sisyphus",
    model: first,
    attempt: 3,
    decision: { retry: false },
    error,
    ...overrides,
  }
}

async function install(f: ReturnType<typeof fixture>) {
  const installed = await installNativeRuntimeFallback(f.fake.context, f.hooks)
  if (!installed) throw new Error("Native fallback was not installed")
  cleanups.push(() => installed.dispose())
  return installed
}

async function triggerQuotaResponse(f: ReturnType<typeof fixture>, event: V2HttpResponseHookEvent) {
  const request = await f.fake.triggerHttpRequest({
    sessionID: event.sessionID,
    agent: event.agent,
    model: event.model,
    kind: event.kind,
    request: event.request,
  })
  return f.fake.triggerHttpResponse({ connectionKey: "credential:a", ...event, request: request.request })
}

describe("native runtime fallback", () => {
  test("admits only one concurrent recovery after deferred connection lookups", async () => {
    const f = fixture()
    const controller = f.runtime.native
    if (!controller) throw new Error("Native controller was not created")
    const lookup = Promise.withResolvers<ReadonlyMap<string, string>>()
    const applying = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let applications = 0
    controller.setCurrentConnections(() => lookup.promise)
    const input = {
      sessionID: "ses_concurrent",
      agent: "sisyphus",
      model: "anthropic/first",
      error: { name: "QuotaExceededError", data: { message: "quota exhausted" } },
    }
    const apply = async () => {
      applications++
      applying.resolve()
      await release.promise
    }
    const firstAttempt = controller.recover(input, apply)
    const secondAttempt = controller.recover(input, apply)
    lookup.resolve(new Map())
    await applying.promise
    release.resolve()
    const outcomes = await Promise.all([firstAttempt, secondAttempt])
    expect(applications).toBe(1)
    expect(outcomes).toEqual([true, false])
    controller.forget("ses_concurrent")
  })

  test("the existing response fixture filters by provider and disposes callbacks independently", async () => {
    const f = fixture()
    const seen: string[] = []
    const openai = await f.fake.context.session.hook(
      "http.response",
      () => {
        seen.push("openai")
      },
      { providerID: "openai" },
    )
    const anthropic = await f.fake.context.session.hook(
      "http.response",
      () => {
        seen.push("anthropic")
      },
      { providerID: "anthropic" },
    )
    const event = {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: first,
      kind: "primary" as const,
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("ok"),
    }
    await f.fake.triggerHttpResponse(event)
    await anthropic.dispose()
    await f.fake.triggerHttpResponse(event)
    expect(seen).toEqual(["anthropic"])
    expect(f.fake.sessionHookCount()).toBe(1)
    await openai.dispose()
    expect(f.fake.sessionHookCount()).toBe(0)
  })

  test("observes a scoped response without consuming its stream and clears the bridge on disposal", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture()
    const other = fixture()
    const installed = await install(f)
    await install(other)
    const response = new Response("stream content", {
      headers: {
        "anthropic-ratelimit-requests-remaining": "0",
        "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
      },
    })
    const event = {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: second,
      kind: "primary" as const,
      request: new Request("https://api.anthropic.com/v1/messages"),
      response,
    }
    const result = await triggerQuotaResponse(f, event)
    expect(result.response).toBe(response)
    expect(await result.response.text()).toBe("stream content")
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set(["anthropic/second"]))
    expect(await getNativeUnavailableModels(other.input.client)).toEqual(new Set())
    expect(f.fake.sessionCalls).toEqual([])
    await installed.dispose()
    expect(await getNativeUnavailableModels(f.input.client)).toBeUndefined()
    expect(f.fake.sessionHookCount()).toBe(0)
  })

  test("retains quota by selected connection across a delayed response and switching back", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture()
    await install(f)
    const event = {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: first,
      kind: "primary" as const,
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("old stream", {
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
        },
      }),
    }
    f.setConnection("b")
    const late = await f.fake.triggerHttpResponse({ ...event, connectionKey: "credential:a" })
    expect(late.response).toBe(event.response)
    expect(await late.response.text()).toBe("old stream")
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set())
    f.setConnection("a")
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set(["anthropic/first"]))
    f.setConnection("b")
    await triggerQuotaResponse(f, {
      ...event,
      connectionKey: "credential:b",
      model: second,
      response: new Response("new stream", { headers: event.response.headers }),
    })
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set(["anthropic/second"]))
    f.setConnection("a")
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set(["anthropic/first"]))
  })

  test("ignores a missing response key and an unavailable active identity", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture()
    await install(f)
    const event = {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: first,
      kind: "primary" as const,
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("ok", {
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
        },
      }),
    }
    await f.fake.triggerHttpResponse(event)
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set())
    await triggerQuotaResponse(f, event)
    f.setConnectionFailure(true)
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set())
    f.setConnectionFailure(false)
    f.setConnection(undefined)
    expect(await getNativeUnavailableModels(f.input.client)).toEqual(new Set())
  })

  test("skips a quota-blocked recovery candidate even when the host catalog is unknown", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture({ agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third"] } } })
    await install(f)
    await triggerQuotaResponse(f, {
      sessionID: "other",
      agent: "sisyphus",
      model: second,
      kind: "primary",
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("ok", {
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
        },
      }),
    })
    await f.fake.triggerRetry(retry({ type: "provider.quota", message: "balance unavailable" }))
    expect(f.fake.sessionCalls).toEqual([
      {
        kind: "switchModel",
        sessionID: "ses_main",
        model: { providerID: "anthropic", id: "third", variant: undefined },
      },
    ])
  })

  test("waits for the authoritative reset before restoring the primary model", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } },
      runtime_fallback: { cooldown_seconds: 0, restore_primary_after_cooldown: true },
    })
    await install(f)
    await triggerQuotaResponse(f, {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: first,
      kind: "primary",
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("ok", {
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
        },
      }),
    })
    await f.fake.triggerRetry(retry({ type: "provider.quota", message: "balance unavailable" }))
    await f.fake.triggerPrompt({ sessionID: "ses_main", messageID: "msg_one", prompt: { text: "next" } })
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
    await clock.advanceBy(3_600_000)
    await f.fake.triggerPrompt({ sessionID: "ses_main", messageID: "msg_two", prompt: { text: "next" } })
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
      { kind: "switchModel", sessionID: "ses_main", model: { ...first, variant: undefined } },
    ])
  })

  test("continues after the current chain entry when a new quota observation removes it", async () => {
    const clock = installRuntimeFallbackTestClock(Date.parse("2026-11-06T10:00:00Z"))
    cleanups.push(clock.restore)
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third"] } },
      runtime_fallback: { cooldown_seconds: 0 },
    })
    await install(f)
    await f.fake.triggerRetry(retry({ type: "provider.quota", message: "balance unavailable" }))
    await triggerQuotaResponse(f, {
      sessionID: "ses_main",
      agent: "sisyphus",
      model: second,
      kind: "primary",
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("ok", {
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
        },
      }),
    })
    await f.fake.triggerRetry(retry({ type: "provider.quota", message: "balance unavailable" }, { model: second }))
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
      {
        kind: "switchModel",
        sessionID: "ses_main",
        model: { providerID: "anthropic", id: "third", variant: undefined },
      },
    ])
  })

  test("preserves the first same-model 503 retry at attempt 2 before switching once at attempt 3", async () => {
    // given
    const f = fixture()
    await install(f)
    const error = { type: "provider.api", message: "Service unavailable", status: 503 }
    const event = retry(error, { attempt: 2, decision: { retry: true, delay: 4567 } })
    const decision = event.decision
    // when
    await f.fake.triggerRetry(event)
    // then
    expect(event.decision).toBe(decision)
    expect(f.fake.sessionCalls).toEqual([])
    const next = await f.fake.triggerRetry(retry(error, { attempt: 3 }))
    expect(next.decision).toEqual({ retry: true, delay: 0 })
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
  })

  test.each([
    { type: "provider.quota", message: "balance unavailable" },
    { type: "provider.no-route", message: "Model unavailable" },
  ])("switches immediately at attempt 2 for $type", async (error) => {
    // given
    const f = fixture()
    await install(f)
    // when
    const event = await f.fake.triggerRetry(retry(error, { attempt: 2 }))
    // then
    expect(event.decision).toEqual({ retry: true, delay: 0 })
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
  })

  test("uses configured first-progress and stall limits to interrupt and resume with a native fallback", async () => {
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } },
      runtime_fallback: { first_progress_timeout_seconds: 2, stall_timeout_seconds: 4 },
    })
    const installed = await install(f)
    await f.fake.triggerModelRequest({
      sessionID: "ses_main",
      agent: "sisyphus",
      model: first,
      kind: "primary",
      headers: {},
    })
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
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } },
      runtime_fallback: { first_progress_timeout_seconds: 2, stall_timeout_seconds: 4 },
    })
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
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
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
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/wrong"] } },
      categories: { quick: { models: ["anthropic/first", "anthropic/second(high)"] } },
    })
    SessionCategoryRegistry.register("ses_child", "quick")
    await install(f)
    // when
    await f.fake.triggerRetry(
      retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }, { sessionID: "ses_child" }),
    )
    // then
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_child", model: { ...second, variant: "high" } },
    ])
  })

  test("keeps a chain entry's own reasoning after fallback", async () => {
    // given
    const f = fixture({
      agents: {
        sisyphus: {
          reasoning: "low",
          models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }],
        },
      },
    })
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([
      {
        kind: "switchModel",
        sessionID: "ses_main",
        model: { providerID: "anthropic", id: "claude-sonnet-4-6", variant: "high" },
      },
    ])
  })

  test("sends a chain entry's reasoning as request options when the model has no matching variant", async () => {
    // given
    const f = fixture({
      agents: {
        sisyphus: { models: ["anthropic/first", { model: "anthropic/second", reasoning: "high", temperature: 0.2 }] },
      },
    })
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
    expect(getSessionPromptParams("ses_main")).toMatchObject({ temperature: 0.2, options: { reasoningEffort: "high" } })
  })

  test("drops a variant the host model does not offer instead of failing the retry", async () => {
    // given
    const sonnet = hostModel("anthropic", "claude-sonnet-4-6")
    const f = fixture(
      {
        agents: {
          sisyphus: { models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }] },
        },
      },
      [],
      first,
      [hostModel("anthropic", "first"), { ...sonnet, variants: [{ id: "low" }] }],
    )
    await install(f)
    // when
    await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(f.fake.sessionCalls).toEqual([
      {
        kind: "switchModel",
        sessionID: "ses_main",
        model: { providerID: "anthropic", id: "claude-sonnet-4-6", variant: undefined },
      },
    ])
  })

  test("reports the model and effort that native fallback applied in the job snapshot", async () => {
    // given
    const f = fixture(
      {
        agents: {
          sisyphus: { models: ["anthropic/first", { model: "anthropic/claude-sonnet-4-6", reasoning: "high" }] },
        },
      },
      [],
      first,
      [hostModel("anthropic", "first"), { ...hostModel("anthropic", "claude-sonnet-4-6"), variants: [{ id: "high" }] }],
    )
    const installed = await install(f)
    const task: BackgroundTask = {
      id: "task_snapshot",
      sessionId: "ses_snapshot",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      agent: "sisyphus",
      prompt: "child",
      description: "child",
      status: "running",
      model: { providerID: "anthropic", modelID: "first", variant: "low" },
    }
    cleanups.push(() =>
      installed.beforeEvent({ type: "session.deleted", data: { sessionID: "ses_snapshot" } }).then(() => {}),
    )
    // when
    await f.fake.triggerRetry(
      retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }, { sessionID: "ses_snapshot" }),
    )
    // then
    expect(getNativeFallbackModel("ses_snapshot")).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "high",
    })
    expect(toBackgroundTaskSnapshots([task])[0]).toMatchObject({ model: "claude-sonnet-4-6", reasoningEffort: "high" })
  })

  test("skips a chain entry whose provider the host does not serve", async () => {
    // given
    const f = fixture(
      { agents: { sisyphus: { models: ["anthropic/first", "missing/model", "anthropic/second"] } } },
      [],
      first,
      [hostModel("anthropic", "first"), hostModel("anthropic", "second")],
    )
    await install(f)
    // when
    const event = await f.fake.triggerRetry(retry({ type: "provider.rate-limit", message: "rate limit", status: 429 }))
    // then
    expect(event.decision).toEqual({ retry: true, delay: 0 })
    expect(f.fake.sessionCalls).toEqual([
      { kind: "switchModel", sessionID: "ses_main", model: { ...second, variant: undefined } },
    ])
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

  test("wraps between expired chain models only up to the native fallback budget", async () => {
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } },
      runtime_fallback: { cooldown_seconds: 0, max_fallback_attempts: 5 },
    })
    await install(f)
    const decisions = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const model = (await f.fake.context.session.get({ sessionID: "ses_main" })).model
      if (!model) throw new Error("Session model missing")
      const result = await f.fake.triggerRetry(
        retry({ type: "provider.quota", message: "quota exceeded" }, { model, attempt: 2 }),
      )
      decisions.push(result.decision)
    }
    expect(f.fake.sessionCalls.filter((call) => call.kind === "switchModel").map((call) => call.model.id)).toEqual([
      "second",
      "first",
      "second",
      "first",
      "second",
    ])
    expect(decisions).toEqual([...Array.from({ length: 5 }, () => ({ retry: true, delay: 0 })), { retry: false }])
  })

  test.each([
    { response: { body: '{"type":"error","error":{"type":"rate_limit_error","retry_after":86400}}' } },
    { retryAfterMs: 86_400_000 },
  ])("retains the provider reset deadline through exhausted recovery and primary restoration", async (window) => {
    const clock = installRuntimeFallbackTestClock()
    cleanups.push(clock.restore)
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second"] } },
      runtime_fallback: { cooldown_seconds: 60, restore_primary_after_cooldown: true },
    })
    await install(f)
    await f.fake.triggerRetry(
      retry(
        { type: "provider.rate-limit", status: 429, message: "Claude Max rate limit reached", ...window },
        { attempt: 2 },
      ),
    )
    await clock.advanceBy(61_000)
    await f.fake.triggerPrompt({ sessionID: "ses_main", messageID: "msg_before_reset", prompt: { text: "next" } })
    const exhausted = await f.fake.triggerRetry(
      retry({ type: "provider.quota", message: "quota exceeded" }, { model: second }),
    )
    expect(exhausted.decision).toEqual({ retry: false })
    expect((await f.fake.context.session.get({ sessionID: "ses_main" })).model?.id).toBe("second")
    await clock.advanceBy(86_339_000)
    const restored = await f.fake.triggerRetry(
      retry({ type: "provider.quota", message: "quota exceeded" }, { model: second }),
    )
    expect(restored.decision).toEqual({ retry: true, delay: 0 })
    expect((await f.fake.context.session.get({ sessionID: "ses_main" })).model?.id).toBe("first")
  })

  test("rolls back selection when a durable model switch fails", async () => {
    // given
    const f = fixture()
    const original = f.fake.context.session.switchModel
    let fail = true
    const context = {
      ...f.fake.context,
      session: {
        ...f.fake.context.session,
        switchModel: async (input: Parameters<typeof original>[0]) => {
          if (fail) throw new Error("switch failed")
          await original(input)
        },
      },
    }
    const installed = await installNativeRuntimeFallback(context, f.hooks)
    cleanups.push(() => installed?.dispose())
    await expect(f.fake.triggerRetry(retry({ type: "provider.auth", message: "no credential" }))).rejects.toThrow(
      "switch failed",
    )
    fail = false
    // when
    await f.fake.triggerRetry(retry({ type: "provider.auth", message: "no credential" }))
    // then
    expect((await context.session.get({ sessionID: "ses_main" })).model).toEqual({ ...second, variant: undefined })
  })

  test("respects the shared maximum fallback attempt count", async () => {
    // given
    const f = fixture({
      agents: { sisyphus: { models: ["anthropic/first", "anthropic/second", "anthropic/third", "anthropic/fourth"] } },
    })
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
    const task: BackgroundTask = {
      id: "task_1",
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      agent: "sisyphus",
      prompt: "original child request",
      description: "child",
      status: "running",
      attemptCount: 0,
      fallbackChain: [{ model: "second", providers: ["anthropic"] }],
      model: { providerID: "anthropic", modelID: "first" },
    }
    // when
    const handled = await tryFallbackRetry({
      task,
      client: f.input.client,
      errorInfo: { statusCode: 429, message: "rate limit" },
      source: "session.error",
      concurrencyManager: new ConcurrencyManager(),
      idleDeferralTimers: new Map(),
      queuesByKey: new Map(),
      processKey: () => {},
      deps: { readConnectedProvidersCache: () => null, readProviderModelsCache: () => null },
    })
    // then
    expect(handled).toBe(false)
    expect(task.status).toBe("running")
    expect(f.fake.sessionCalls).toEqual([])
  })

  test("recovers preparation failure with one idempotent synthetic continuation", async () => {
    // given
    const error = { type: "provider.no-route", message: "Model unavailable" }
    const history: V2SessionMessage[] = [
      { type: "user", id: "msg_user", text: "original task", time: { created: 1 } },
      { type: "idle", id: "msg_failure", outcome: "failed", error, time: { created: 2 } },
    ]
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
    // a stable per-failure ID lets the host's atomic recovery admission deduplicate replays
    expect(continuation?.input.id).toMatch(/^msg_[0-9a-f]{26}$/)
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
    const cleanup = await createV2Setup({
      serverPlugin: async () => f.hooks,
      warn: (message) => {
        throw new Error(message)
      },
    })(f.fake.context)
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
    const f = fixture(
      undefined,
      [{ type: "idle", id: "msg_failed", outcome: "failed", error, time: { created: 1 } }],
      null,
    )
    const installed = await install(f)
    // when
    const recovered = await installed.beforeEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_main", error },
    })
    // then
    expect(recovered).toBe(true)
    expect((await f.fake.context.session.get({ sessionID: "ses_main" })).model).toEqual({
      ...second,
      variant: undefined,
    })
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

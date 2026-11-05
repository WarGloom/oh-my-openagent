import { afterEach, expect, spyOn, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../config"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import * as logger from "../shared/logger"
import { createPluginInput } from "./create-plugin-input"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { createSessionTracker } from "./session-tracker"
import type { V2RetryHookEvent, V2StructuredError } from "./context-types"

const first = { providerID: "openai", id: "gpt-6.1-sol" }
const second = { providerID: "anthropic", id: "claude-sonnet-5-5" }
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(error: V2StructuredError, models = ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"]) {
  const fake = createFakePluginContext({ sessionAgent: "sisyphus", sessionInfo: { model: first }, sessionMessages: [{ type: "idle", id: "msg_failed", outcome: "failed", error, time: { created: 1 } }] })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const runtime = createRuntimeFallbackHook(input, { pluginConfig: OhMyOpenCodeConfigSchema.parse({ agents: { sisyphus: { models } } }), config: { enabled: true, timeout_seconds: 0, notify_on_fallback: false } })
  const hooks: Hooks = {}
  bindNativeRuntimeFallback(hooks, runtime)
  const installed = await installNativeRuntimeFallback(fake.context, hooks)
  if (!installed) throw new Error("Native fallback was not installed")
  cleanups.push(async () => {
    runtime.native?.forget("ses_decision")
    await installed.dispose()
    runtime.dispose?.()
  })
  const log = spyOn(logger, "log")
  cleanups.push(() => log.mockRestore())
  const decisions = () => log.mock.calls.filter(([message]) => message === "[runtime-fallback] Native recovery decision").map(([, details]) => details)
  return { fake, installed, decisions }
}

test.each([
  { error: { type: "provider.internal", status: 503, message: "Service unavailable" }, attempt: 1, fallback: false, classification: undefined, name: "provider.internal" },
  { error: { type: "provider.internal", status: 503, message: "Service unavailable" }, attempt: 2, fallback: false, classification: undefined, name: "provider.internal" },
  { error: { type: "provider.internal", status: 503, message: "Service unavailable" }, attempt: 3, fallback: true, classification: undefined, name: "provider.internal" },
  { error: { type: "provider.quota", status: 429, message: "balance unavailable" }, attempt: 1, fallback: true, classification: "quota_exceeded", name: "QuotaExceededError" },
  { error: { type: "provider.internal", status: 200, message: "Usage limit reached. Retrying in 2 weeks" }, attempt: 1, fallback: true, classification: "quota_exceeded", name: "provider.internal" },
  { error: { type: "provider.rate-limit", status: 429, message: "Rate limit exhausted" }, attempt: 1, fallback: true, classification: "quota_exceeded", name: "provider.rate-limit" },
  { error: { type: "provider.no-route", message: "Model unavailable" }, attempt: 1, fallback: true, classification: "model_not_found", name: "ProviderModelNotFoundError" },
])("logs and applies the V1 retry timing for $error.type at attempt $attempt", async ({ error, attempt, fallback, classification, name }) => {
  // given
  const f = await fixture(error)
  const event: V2RetryHookEvent = { sessionID: "ses_decision", agent: "sisyphus", model: first, error, attempt, decision: { retry: true, delay: 4567 } }
  const decision = event.decision
  // when
  await f.fake.triggerRetry(event)
  // then
  if (fallback) expect(event.decision).toEqual({ retry: true, delay: 0 })
  else expect(event.decision).toBe(decision)
  expect((await f.fake.context.session.get({ sessionID: "ses_decision" })).model).toEqual(fallback ? { ...second, variant: undefined } : first)
  expect(f.decisions()).toEqual([{
    sessionID: "ses_decision", source: "retry", attempt, model: "openai/gpt-6.1-sol",
    error: { type: error.type, name, classification, status: error.status, message: error.message },
    outcome: fallback ? "fallback to anthropic/claude-sonnet-5-5" : "left to V2's same-model retry",
  }])
})

test.each([
  { error: { type: "provider.internal", status: 200, message: "api_error: Claude Code returned an error result: Invalid API key · Fix external API key" }, fallback: false, classification: undefined, name: "provider.internal" },
  { error: { type: "provider.auth", status: 401, message: "No credential" }, fallback: true, classification: "missing_api_key", name: "AI_LoadAPIKeyError" },
  { error: { type: "provider.internal", status: 503, message: "Service unavailable" }, fallback: true, classification: undefined, name: "provider.internal" },
])("logs the shared V1 terminal decision for $error.type ($error.status)", async ({ error, fallback, classification, name }) => {
  // given
  const f = await fixture(error)
  // when
  const consumed = await f.installed.beforeEvent({ type: "session.execution.failed", data: { sessionID: "ses_decision", error } })
  // then
  expect(consumed).toBe(fallback)
  expect(f.fake.sessionCalls.map((call) => call.kind)).toEqual(fallback ? ["switchModel", "synthetic"] : [])
  expect(f.decisions()).toEqual([{
    sessionID: "ses_decision", source: "terminal", attempt: undefined, model: "openai/gpt-6.1-sol",
    error: { type: error.type, name, classification, status: error.status, message: error.message },
    outcome: fallback ? "fallback to anthropic/claude-sonnet-5-5" : "declined as not retryable",
  }])
})

test.each(["retry", "terminal"])("logs exhausted chains and bounds the error message on the %s path", async (source) => {
  // given
  const message = "Quota exceeded: " + "x".repeat(400)
  const error = { type: "provider.quota", status: 429, message }
  const f = await fixture(error, ["openai/gpt-6.1-sol"])
  // when
  if (source === "retry") {
    const event: V2RetryHookEvent = { sessionID: "ses_decision", agent: "sisyphus", model: first, error, attempt: 5, decision: { retry: true, delay: 900_000 } }
    await f.fake.triggerRetry(event)
    expect(event.decision).toEqual({ retry: false })
    expect(event.error).toBe(error)
  } else {
    expect(await f.installed.beforeEvent({ type: "session.execution.failed", data: { sessionID: "ses_decision", error } })).toBe(false)
  }
  // then
  expect(f.fake.sessionCalls).toEqual([])
  expect(f.decisions()).toEqual([{
    sessionID: "ses_decision", source, attempt: source === "retry" ? 5 : undefined, model: "openai/gpt-6.1-sol",
    error: { type: "provider.quota", name: "QuotaExceededError", classification: "quota_exceeded", status: 429, message: message.slice(0, 300) },
    outcome: "declined because no chain models remain",
  }])
})

test("retains transient throttling Retry-After when the configured chain is exhausted", async () => {
  const error = { type: "provider.rate-limit", status: 429, message: "Too many requests. Please retry later." }
  const f = await fixture(error, ["openai/gpt-6.1-sol"])
  const event: V2RetryHookEvent = { sessionID: "ses_decision", agent: "sisyphus", model: first, error, attempt: 5, decision: { retry: true, delay: 12_345 } }
  const decision = event.decision
  await f.fake.triggerRetry(event)
  expect(event.decision).toBe(decision)
  expect(f.fake.sessionCalls).toEqual([])
})

test("does not treat an in-flight fallback as hard-quota chain exhaustion", async () => {
  const error = { type: "provider.rate-limit", status: 429, message: "You have exceeded your weekly rate limit." }
  const f = await fixture(error)
  const applying = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const switchModel = f.fake.context.session.switchModel
  f.fake.context.session.switchModel = async (input) => {
    applying.resolve()
    await release.promise
    return switchModel(input)
  }
  const initial: V2RetryHookEvent = { sessionID: "ses_decision", agent: "sisyphus", model: first, error, attempt: 5, decision: { retry: true, delay: 900_000 } }
  const pending = f.fake.triggerRetry(initial)
  try {
    await applying.promise
    const concurrent: V2RetryHookEvent = { ...initial, decision: { retry: true, delay: 1234 } }
    const decision = concurrent.decision
    await f.fake.triggerRetry(concurrent)
    expect(concurrent.decision).toBe(decision)
  } finally {
    release.resolve()
    await pending
  }
  expect(initial.decision).toEqual({ retry: true, delay: 0 })
})

test("stops the exact weekly provider quota retry when no configured fallback remains", async () => {
  const error = { type: "provider.rate-limit", status: 429, message: "You have exceeded your weekly rate limit." }
  const f = await fixture(error, ["openai/gpt-6.1-sol"])
  const event: V2RetryHookEvent = { sessionID: "ses_decision", agent: "sisyphus", model: first, error, attempt: 5, decision: { retry: true, delay: 900_000 } }
  await f.fake.triggerRetry(event)
  expect(event.decision).toEqual({ retry: false })
  expect(event.error).toBe(error)
  expect(f.fake.sessionCalls).toEqual([])
})

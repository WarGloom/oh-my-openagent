import { expect, spyOn, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createToolExecuteBeforeHandler } from "../plugin/tool-execute-before"
import { createModelFallbackEventHandler } from "../plugin/event-model-fallback"
import { createModelFallbackHook } from "../hooks/model-fallback/hook"
import { OhMyOpenCodeConfigSchema } from "../config"
import { writeProviderModelsCache } from "../shared/connected-providers-cache"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"
import { startEventBridge } from "./event-bridge"
import { encodeBackgroundTask } from "./background-task-record"
import type { BackgroundTask } from "../features/background-agent/types"
import { createRuntimeFallbackHook } from "../hooks/runtime-fallback/hook"
import { bindNativeRuntimeFallback, installNativeRuntimeFallback } from "./native-runtime-fallback"
import { bindNativeExecutorRequirements } from "./native-executor-requirement"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { V2BackgroundLifecycle } from "./background-lifecycle"
import type { Hooks } from "@opencode-ai/plugin"
import { archiveBackgroundTask, forgetBackgroundTask } from "../features/background-agent/task-registry"

const model = { providerID: "test", id: "first" }
const baseTask = {
  id: "bg_child",
  sessionId: "child",
  parentSessionId: "parent",
  parentMessageId: "message",
  agent: "worker",
  description: "synthetic fixture",
  prompt: "synthetic fixture",
  status: "completed",
  nativeMetadata: { requiredModel: "test/first" },
} satisfies BackgroundTask

test("the installed before-hook chain preserves and rejects a conflicting registered agent", async () => {
  const fake = createFakePluginContext({ directory: "/work/executor-hooks" })
  const cleanup = await createV2Setup({
    serverPlugin: async (input) => ({
      "tool.execute.before": createToolExecuteBeforeHandler({
        ctx: unsafeTestValue(input),
        hooks: unsafeTestValue({}),
      }),
    }),
  })(fake.context)
  const input = {
    tool: "task",
    sessionID: "parent",
    agent: "worker",
    messageID: "message",
    id: "call",
    input: { category: "quick", subagent_type: "specialist" },
  }
  let launches = 0
  try {
    await expect(
      (async () => {
        await fake.triggerToolBefore(input)
        launches++
      })(),
    ).rejects.toMatchObject({ code: "executor_requirement", reason: "agent_conflict" })
    expect(input.input).toEqual({ category: "quick", subagent_type: "specialist" })
    expect(launches).toBe(0)
  } finally {
    await cleanup()
  }
})

test.each([
  { source: "retry", pinned: true },
  { source: "terminal", pinned: true },
  { source: "retry", pinned: false },
] as const)(
  "#given a Terra 503 #when native $source recovery runs with pinned=$pinned #then only an unpinned task can fall back",
  async ({ source, pinned }) => {
    const terra = { providerID: "openai", id: "gpt-6.1-terra", variant: "xhigh" }
    const next = { providerID: "meridian-agy", id: "gemini-4-neon-medium" }
    const error = { type: "provider.internal", status: 503, message: "Service unavailable. Try again in 3s" }
    const fake = createFakePluginContext({
      directory: "/work/executor-native-hooks",
      sessionAgent: "worker",
      sessionInfo: { model: terra, parentID: "parent" },
      sessionMessages: [{ id: "failure", type: "idle", outcome: "failed", error, time: { created: 1 } }],
    })
    if (!fake.context.storage) throw new Error("Native fixture storage is missing")
    const lifecycle = new V2BackgroundLifecycle(fake.context, fake.context.storage)
    await lifecycle.save({ ...baseTask, nativeMetadata: pinned ? { requiredModel: "openai/gpt-6.1-terra" } : {} })
    const context = bindNativeExecutorRequirements(fake.context, (sessionID, parentID) =>
      lifecycle.findRetainedTask(sessionID, parentID),
    )
    const tracker = createSessionTracker()
    const input = createPluginInput(context, { tracker, warn: () => {} })
    const runtime = createRuntimeFallbackHook(input, {
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        agents: { worker: { models: ["openai/gpt-6.1-terra xhigh", "meridian-agy/gemini-4-neon-medium"] } },
      }),
      config: { enabled: true, timeout_seconds: 0, notify_on_fallback: false },
    })
    const hooks: Hooks = {}
    bindNativeRuntimeFallback(hooks, runtime)
    const installed = await installNativeRuntimeFallback(context, hooks)
    if (!installed) throw new Error("Native fallback was not installed")
    const switchModel = spyOn(context.session, "switchModel")
    const continueAfterFailure = spyOn(context.experimental.session, "continueAfterFailure")
    const bridge = startEventBridge(context, { tracker, warn: () => {} })
    const surfaced = Promise.withResolvers<unknown>()
    bridge.setInterceptor(installed.beforeEvent)
    bridge.setHandler(async ({ event }) => {
      if (event.type === "session.error") surfaced.resolve(event.properties.error)
    })
    try {
      if (source === "retry") {
        const decision = { retry: true, delay: 8_000 }
        const retry = await fake.triggerRetry({ sessionID: "child", agent: "worker", model: terra, error, attempt: 5, decision })
        expect(retry.decision).toEqual(pinned ? decision : { retry: true, delay: 0 })
      }
      if (pinned) {
        fake.emit({ type: "session.execution.failed", data: { sessionID: "child", error } })
        expect(await surfaced.promise).toMatchObject({
          name: "provider.internal",
          data: { statusCode: 503, message: error.message },
        })
        expect(switchModel).not.toHaveBeenCalled()
        expect(continueAfterFailure).not.toHaveBeenCalled()
      } else {
        expect((await fake.context.session.get({ sessionID: "child" })).model).toMatchObject(next)
      }
    } finally {
      bridge.stop()
      switchModel.mockRestore()
      continueAfterFailure.mockRestore()
      runtime.native?.forget("child")
      await installed.dispose()
      runtime.dispose?.()
    }
  },
  2_000,
)

test.each(["ordinary", "durable", "archive"] as const)(
  "the installed legacy fallback prompt respects the %s task record with runtime fallback disabled",
  async (source) => {
    const pinned = source !== "ordinary"
    const fake = createFakePluginContext({
      directory: "/work/executor-hooks",
      sessionAgent: "worker",
      sessionInfo: { model, parentID: "parent" },
    })
    writeProviderModelsCache({ connected: ["test"], models: { test: ["first", "second"] } })
    const config = OhMyOpenCodeConfigSchema.parse({
      model_fallback: true,
      runtime_fallback: { enabled: false },
      agents: { worker: { models: ["test/first", "test/second"] } },
    })
    const legacy = createModelFallbackHook()
    if (source === "durable")
      await fake.context.storage?.set(
        `background-task/${encodeURIComponent(fake.context.location.directory)}/${baseTask.id}`,
        encodeBackgroundTask(baseTask),
      )
    if (source === "archive") archiveBackgroundTask(baseTask)
    let events: ReturnType<typeof createModelFallbackEventHandler> | undefined
    const cleanup = await createV2Setup({
      serverPlugin: async (input) => {
        events = createModelFallbackEventHandler({
          pluginConfig: config,
          pluginContext: unsafeTestValue(input),
          modelFallback: legacy,
          isModelFallbackEnabled: true,
          isRuntimeFallbackEnabled: false,
          shouldAutoRetrySession: () => false,
          isSessionStopped: () => false,
        })
        return { "chat.message": legacy["chat.message"] }
      },
    })(fake.context)
    try {
      legacy.setSessionFallbackChain("child", [])
      if (!events) throw new Error("Legacy event owner is missing")
      await events.handleAssistantMessageUpdated({
        sessionID: "child",
        agent: "worker",
        info: {
          id: "failure",
          providerID: "test",
          modelID: "first",
          error: { name: "APIError", data: { statusCode: 429, message: "Rate limit reached" } },
        },
      })
      expect(legacy.hasPendingModelFallback("child")).toBe(true)
      const prompt = fake.triggerPrompt({
        sessionID: "child",
        messageID: "next",
        prompt: { text: "continue the synthetic task" },
      })
      if (pinned) await expect(prompt).rejects.toMatchObject({ code: "executor_requirement", reason: "model_mismatch" })
      else await prompt
      expect((await fake.context.session.get({ sessionID: "child" })).model?.id).toBe(pinned ? "first" : "second")
    } finally {
      await cleanup()
      forgetBackgroundTask(baseTask.id)
      legacy.reset()
      writeProviderModelsCache({ connected: [], models: {} })
    }
  },
)

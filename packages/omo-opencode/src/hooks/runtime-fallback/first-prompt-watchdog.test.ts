import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { subagentSessions } from "../../features/claude-code-session-state"
import { createFirstPromptWatchdog, observeEventForWatchdog, type FirstPromptWatchdog } from "./first-prompt-watchdog"

const WATCHDOG_MS = 100
const SAFE_WAIT_BEFORE_FIRE_MS = 40
const SAFE_WAIT_AFTER_FIRE_MS = 250

type FakeTimers = {
  advanceBy: (ms: number) => Promise<void>
  restore: () => void
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalDateNow = Date.now
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void | Promise<void>>()
  const dueTimes = new Map<ReturnType<typeof setTimeout>, number>()
  let now = Date.now()

  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") {
      throw new Error("String timer handlers are not supported in tests")
    }

    const timer = originalSetTimeout(() => {}, 0)
    originalClearTimeout(timer)
    callbacks.set(timer, () => handler(...args))
    dueTimes.set(timer, now + Math.max(0, delay ?? 0))
    return timer
  }) as typeof setTimeout

  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>): void => {
    callbacks.delete(timer)
    dueTimes.delete(timer)
  }) as typeof clearTimeout
  Date.now = () => now

  return {
    async advanceBy(ms) {
      const target = now + ms
      while (true) {
        const nextTimer = nextTimerDueBefore(target)
        if (!nextTimer) break
        now = dueTimes.get(nextTimer) ?? now
        const callback = callbacks.get(nextTimer)
        callbacks.delete(nextTimer)
        dueTimes.delete(nextTimer)
        await callback?.()
        await flushMicrotasks()
      }
      now = target
      await flushMicrotasks()
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      Date.now = originalDateNow
    },
  }

  function nextTimerDueBefore(target: number): ReturnType<typeof setTimeout> | undefined {
    return [...dueTimes.entries()]
      .filter(([, dueAt]) => dueAt <= target)
      .sort((left, right) => left[1] - right[1])[0]?.[0]
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

function createContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(pluginConfig: HookDeps["pluginConfig"] = undefined): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      first_progress_timeout_seconds: 30,
      stall_timeout_seconds: 600,
      hard_timeout_seconds: 1800,
      notify_on_fallback: false,
      restore_primary_after_cooldown: false,
    },
    options: undefined,
    pluginConfig,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackAbortInFlight: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionFallbackHardTimeouts: new Map(),
    sessionFallbackTimeoutAgents: new Map(),
    sessionFallbackTimeoutKinds: new Map(),
    sessionFallbackProgressObserved: new Set(),
    sessionFallbackUnsafeToReplay: new Set(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
}

interface RecordedCalls {
  abort: Array<{ sessionID: string; source: string }>
  autoRetry: Array<{ sessionID: string; newModel: string; resolvedAgent: string | undefined; source: string }>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function createHelpers(calls: RecordedCalls, resolvedAgentName?: string): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string, source: string) => {
      calls.abort.push({ sessionID, source })
    },
    clearSessionFallbackTimeout: () => {},
    clearSessionFallbackState: () => {},
    scheduleSessionFallbackTimeout: () => {},
    refreshSessionFallbackTimeout: () => false,
    autoRetryWithFallback: async (sessionID, newModel, resolvedAgent, source) => {
      calls.autoRetry.push({ sessionID, newModel, resolvedAgent, source })
      return { accepted: true, status: "dispatched" }
    },
    resolveAgentForSessionFromContext: async () => resolvedAgentName,
    cleanupStaleSessions: () => {},
  }
}

const AGENT = "sisyphus-junior"
const PRIMARY_MODEL = "openai/gpt-5.6-luna-fast"
const FALLBACK_MODEL = "anthropic/claude-haiku-4-5"
const PLUGIN_CONFIG_WITH_FALLBACK = {
  git_master: {
    commit_footer: true,
    include_co_authored_by: true,
    git_env_prefix: "GIT_MASTER=1",
  },
  agents: {
    [AGENT]: {
      model: PRIMARY_MODEL,
      fallback_models: [{ model: FALLBACK_MODEL }],
    },
  },
}

describe("first-prompt-watchdog", () => {
  let fakeTimers: FakeTimers | undefined

  function getFakeTimers(): FakeTimers {
    if (!fakeTimers) {
      throw new Error("Fake timers must be installed before advancing watchdog time")
    }
    return fakeTimers
  }

  beforeEach(() => {
    subagentSessions.clear()
    fakeTimers = installFakeTimers()
  })

  afterEach(() => {
    fakeTimers?.restore()
    fakeTimers = undefined
    subagentSessions.clear()
  })

  it("#given a subagent stays silent past the threshold and has a fallback configured #when the watchdog fires #then it aborts the in-flight request and dispatches the fallback model", async () => {
    // given
    const sessionID = "session-silent-subagent"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([{ sessionID, source: "first-prompt-watchdog" }])
    expect(calls.autoRetry).toHaveLength(1)
    expect(calls.autoRetry[0].sessionID).toBe(sessionID)
    expect(calls.autoRetry[0].newModel).toBe(FALLBACK_MODEL)
    expect(calls.autoRetry[0].source).toBe("first-prompt-watchdog")

    watchdog.dispose()
  })

  it("#given a subagent produces assistant text before the threshold #when progress is observed #then the watchdog is cancelled and no fallback is dispatched", async () => {
    // given
    const sessionID = "session-makes-progress"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_BEFORE_FIRE_MS)
    watchdog.onAssistantProgress(sessionID)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given session emits message.part.updated with sessionID under properties.part #when watchdog tracks #then the watchdog recognizes progress and resets the silence timer", async () => {
    // given
    const sessionID = "session-nested-part-progress"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_BEFORE_FIRE_MS)
    observeEventForWatchdog(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            messageID: "msg-1",
            sessionID,
            type: "text",
            text: "still working",
          },
        },
      },
      watchdog,
    )
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given session emits message.part.delta with field/delta but no part.type #when watchdog tracks #then the watchdog recognizes progress", async () => {
    // given
    const sessionID = "session-delta-progress"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_BEFORE_FIRE_MS)
    observeEventForWatchdog(
      {
        type: "message.part.delta",
        properties: { sessionID, field: "text", delta: "x" },
      },
      watchdog,
    )
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given the session is not a subagent #when a user message is observed #then the watchdog never arms and nothing fires", async () => {
    // given
    const sessionID = "session-not-a-subagent"
    // NOT added to subagentSessions
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given a subagent reaches a terminal session state before the threshold #when onSessionTerminal is called #then the watchdog is cancelled and no fallback is dispatched", async () => {
    // given
    const sessionID = "session-terminated-early"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_BEFORE_FIRE_MS)
    watchdog.onSessionTerminal(sessionID)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given a completed subagent had its watchdog cancelled by progress #when a stale user message arrives after terminal #then it is not rearmed", async () => {
    // given
    const sessionID = "session-terminal-after-progress"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_BEFORE_FIRE_MS)
    watchdog.onAssistantProgress(sessionID)
    watchdog.onSessionTerminal(sessionID)
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given a terminal event arrives before a replayed user message #when the stale user message is observed #then the watchdog is not armed", async () => {
    // given
    const sessionID = "session-terminal-before-user-replay"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onSessionTerminal(sessionID)
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given a terminal event arrives while agent resolution is pending #when resolution completes #then no abort or fallback is dispatched", async () => {
    // given
    const sessionID = "session-terminal-during-agent-resolution"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const deferredAgent = createDeferred<string | undefined>()
    const helpers = {
      ...createHelpers(calls, AGENT),
      resolveAgentForSessionFromContext: async () => deferredAgent.promise,
    }
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    const watchdogFinished = getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)
    await flushMicrotasks()
    watchdog.onSessionTerminal(sessionID)
    deferredAgent.resolve(AGENT)
    await watchdogFinished

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given tool progress makes replay unsafe after the timer fires while agent resolution is pending #when resolution completes #then no abort or fallback is dispatched", async () => {
    // given
    const sessionID = "session-unsafe-during-agent-resolution"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const deferredAgent = createDeferred<string | undefined>()
    const agentResolutionStarted = createDeferred<void>()
    const helpers = {
      ...createHelpers(calls, AGENT),
      resolveAgentForSessionFromContext: async () => {
        agentResolutionStarted.resolve()
        return deferredAgent.promise
      },
    }
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    const watchdogFinished = getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)
    await agentResolutionStarted.promise
    deps.sessionFallbackUnsafeToReplay.add(sessionID)
    deferredAgent.resolve(AGENT)
    await watchdogFinished

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe(PRIMARY_MODEL)

    watchdog.dispose()
  })

  it("#given a subagent silent past the threshold with no fallback configured #when the watchdog fires #then it logs but does not abort or dispatch (lets the existing error-event paths handle it if one arrives later)", async () => {
    // given
    const sessionID = "session-no-fallback"
    subagentSessions.add(sessionID)
    const deps = createDeps()
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, WATCHDOG_MS)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })

  it("#given the watchdog timeout is disabled #when a subagent user message is observed #then no fallback is dispatched", async () => {
    // given
    const sessionID = "session-watchdog-disabled"
    subagentSessions.add(sessionID)
    const deps = createDeps(PLUGIN_CONFIG_WITH_FALLBACK)
    const calls: RecordedCalls = { abort: [], autoRetry: [] }
    const helpers = createHelpers(calls, AGENT)
    const watchdog = createFirstPromptWatchdog(deps, helpers, 0)

    // when
    watchdog.onUserMessage(sessionID, PRIMARY_MODEL, AGENT)
    await getFakeTimers().advanceBy(SAFE_WAIT_AFTER_FIRE_MS)

    // then
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    watchdog.dispose()
  })
})

interface RecordedWatchdogCalls {
  user: Array<{ sessionID: string; model?: string; agent?: string }>
  progress: string[]
  terminal: string[]
}

function createRecordingWatchdog(calls: RecordedWatchdogCalls): FirstPromptWatchdog {
  return {
    onUserMessage(sessionID, model, agent) {
      calls.user.push({ sessionID, model, agent })
    },
    onAssistantProgress(sessionID) {
      calls.progress.push(sessionID)
    },
    onSessionTerminal(sessionID) {
      calls.terminal.push(sessionID)
    },
    dispose() {},
  }
}

describe("observeEventForWatchdog", () => {
  const sessionID = "session-observed"

  function freshCalls(): RecordedWatchdogCalls {
    return { user: [], progress: [], terminal: [] }
  }

  it("#given a message.updated event with role=user #when observed #then onUserMessage is called with sessionID/model/agent", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "user", model: "openai/gpt-5.6-luna-fast", agent: "sisyphus-junior" } },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.user).toEqual([{ sessionID, model: "openai/gpt-5.6-luna-fast", agent: "sisyphus-junior" }])
    expect(calls.progress).toEqual([])
    expect(calls.terminal).toEqual([])
  })

  const assistantProgressParts: ReadonlyArray<readonly [string, { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly tool_use_id?: string }]> = [
    ["text", { type: "text", text: "hello" }],
    ["reasoning", { type: "reasoning", text: "thinking..." }],
    ["tool", { type: "tool" }],
    ["tool_use", { type: "tool_use", id: "t1", name: "Read" }],
    ["tool_result", { type: "tool_result", tool_use_id: "t1" }],
    ["tool-call", { type: "tool-call" }],
    ["step-start", { type: "step-start" }],
    ["file", { type: "file" }],
  ]

  for (const [label, part] of assistantProgressParts) {
    it(`#given a message.updated assistant event whose only part is type=${label} #when observed #then onAssistantProgress is called (model is *working*, not silent)`, () => {
      const calls = freshCalls()
      observeEventForWatchdog(
        {
          type: "message.updated",
          properties: { info: { sessionID, role: "assistant" }, parts: [part] },
        },
        createRecordingWatchdog(calls),
      )
      expect(calls.progress).toEqual([sessionID])
    })
  }

  for (const [label, part] of assistantProgressParts) {
    it(`#given a message.part.updated event whose part is type=${label} #when observed #then onAssistantProgress is called`, () => {
      const calls = freshCalls()
      observeEventForWatchdog(
        {
          type: "message.part.updated",
          properties: { sessionID, part },
        },
        createRecordingWatchdog(calls),
      )
      expect(calls.progress).toEqual([sessionID])
    })
  }

  it("#given a message.updated assistant event with parts: [] and no error/finish #when observed #then no progress is signalled (no activity yet)", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "assistant" }, parts: [] },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.progress).toEqual([])
  })

  it("#given a message.updated assistant event with info.error set #when observed #then onAssistantProgress is called (the existing error-handling path takes over from here)", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "assistant", error: { name: "RateLimitError", message: "429" } } },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.progress).toEqual([sessionID])
  })

  it("#given a message.updated assistant event with info.finish set #when observed #then onAssistantProgress is called", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "assistant", finish: "stop" } },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.progress).toEqual([sessionID])
  })

  const terminalEventTypes: ReadonlyArray<readonly [string]> = [["session.idle"], ["session.stop"], ["session.deleted"], ["session.error"]]

  for (const [eventType] of terminalEventTypes) {
    it(`#given a ${eventType} event #when observed #then onSessionTerminal is called`, () => {
      const calls = freshCalls()
      observeEventForWatchdog(
        { type: eventType, properties: { sessionID } },
        createRecordingWatchdog(calls),
      )
      expect(calls.terminal).toEqual([sessionID])
    })
  }

  it("#given a session.deleted event whose sessionID is carried under properties.info.id #when observed #then onSessionTerminal is still called (matches event-handler shape)", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      { type: "session.deleted", properties: { info: { id: sessionID } } },
      createRecordingWatchdog(calls),
    )
    expect(calls.terminal).toEqual([sessionID])
  })

  it("#given an unrelated event type #when observed #then no watchdog method is called", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      { type: "session.created", properties: { info: { id: sessionID } } },
      createRecordingWatchdog(calls),
    )
    expect(calls.user).toEqual([])
    expect(calls.progress).toEqual([])
    expect(calls.terminal).toEqual([])
  })

  it("#given a tool.execute.before event #when observed #then no progress is signalled (tool events are not session progress)", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "tool.execute.before",
        properties: { sessionID, toolName: "Read", input: { filePath: "test.ts" } },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.progress).toEqual([])
    expect(calls.terminal).toEqual([])
  })

  it("#given a tool.execute.after event #when observed #then no progress is signalled", () => {
    const calls = freshCalls()
    observeEventForWatchdog(
      {
        type: "tool.execute.after",
        properties: { sessionID, toolName: "Read", output: "file content" },
      },
      createRecordingWatchdog(calls),
    )
    expect(calls.progress).toEqual([])
    expect(calls.terminal).toEqual([])
  })
})

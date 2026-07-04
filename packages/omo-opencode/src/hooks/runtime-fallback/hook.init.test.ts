import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { subagentSessions } from "../../features/claude-code-session-state"
import type { OhMyOpenCodeConfig } from "../../config"
import type { AutoRetryHelpers } from "./auto-retry"
import type { FirstPromptWatchdog } from "./first-prompt-watchdog"
import type { HookDeps, RuntimeFallbackInterval, RuntimeFallbackPluginInput } from "./types"

type RuntimeFallbackModule = typeof import("./hook")

import { DEFAULT_CONFIG } from "./constants"

const basePluginConfig = {
  git_master: {
    commit_footer: true,
    include_co_authored_by: true,
    git_env_prefix: "GIT_MASTER=1",
  },
} satisfies OhMyOpenCodeConfig

const loadPluginConfigMock = mock(() => basePluginConfig)
const createAutoRetryHelpersMock = mock((_deps: HookDeps) => {
  void _deps

  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    clearSessionFallbackState: () => {},
    scheduleSessionFallbackTimeout: () => {},
    refreshSessionFallbackTimeout: () => false,
    autoRetryWithFallback: async () => {},
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
})
const createEventHandlerMock = mock(() => async () => {})
const createMessageUpdateHandlerMock = mock(() => async () => {})
const createChatMessageHandlerMock = mock(() => async () => {})

function registerModuleMocks(): void {
  mock.module("../../plugin-config", () => ({
    loadPluginConfig: loadPluginConfigMock,
  }))

  mock.module("./auto-retry", () => ({
    createAutoRetryHelpers: createAutoRetryHelpersMock,
  }))

  mock.module("./event-handler", () => ({
    createEventHandler: createEventHandlerMock,
  }))

  mock.module("./message-update-handler", () => ({
    createMessageUpdateHandler: createMessageUpdateHandlerMock,
  }))

  mock.module("./chat-message-handler", () => ({
    createChatMessageHandler: createChatMessageHandlerMock,
  }))
}

function createMockContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({}),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test",
  }
}

function createMockInterval(): RuntimeFallbackInterval {
  return {
    unref: () => {},
  }
}

function createRecordingHelpers(refreshCalls: Array<{ sessionID: string; source: string }>): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    clearSessionFallbackState: () => {},
    scheduleSessionFallbackTimeout: () => {},
    refreshSessionFallbackTimeout: (sessionID, source) => {
      refreshCalls.push({ sessionID, source })
      return false
    },
    autoRetryWithFallback: async () => {},
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

function createRecordingWatchdog(progressCalls: string[]): FirstPromptWatchdog {
  return {
    onUserMessage() {},
    onAssistantProgress(sessionID) {
      progressCalls.push(sessionID)
    },
    onSessionTerminal() {},
    dispose() {},
  }
}

describe("createRuntimeFallbackHook initialization", () => {
  const originalSetInterval = globalThis.setInterval
  let setIntervalCalls = 0
  let createRuntimeFallbackHook: RuntimeFallbackModule["createRuntimeFallbackHook"]

  beforeEach(async () => {
    mock.restore()
    registerModuleMocks()
    loadPluginConfigMock.mockClear()
    createAutoRetryHelpersMock.mockClear()
    createEventHandlerMock.mockClear()
    createMessageUpdateHandlerMock.mockClear()
    createChatMessageHandlerMock.mockClear()
    setIntervalCalls = 0
    subagentSessions.clear()

    globalThis.setInterval = ((callback: Parameters<typeof originalSetInterval>[0], delay?: number) => {
      void callback
      void delay
      setIntervalCalls += 1
      return createMockInterval() as unknown as ReturnType<typeof globalThis.setInterval>
    }) as typeof globalThis.setInterval

    const cacheBuster = `${Date.now()}-${Math.random()}`
    const runtimeFallbackModule: RuntimeFallbackModule = await import(`./hook?test=${cacheBuster}`)
    createRuntimeFallbackHook = runtimeFallbackModule.createRuntimeFallbackHook
  })

  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    mock.restore()
    subagentSessions.clear()
  })

  test("#given injected pluginConfig #when the hook factory runs #then loadPluginConfig is not called", () => {
    // given
    const pluginConfig = basePluginConfig

    // when
    createRuntimeFallbackHook(createMockContext(), { pluginConfig })

    // then
    expect(loadPluginConfigMock).not.toHaveBeenCalled()
  })

  test("#given no runtime fallback timeout override #when the hook factory runs #then the first-prompt watchdog uses the runtime fallback default timeout", () => {
    // given
    let watchdogMs: number | undefined

    // when
    createRuntimeFallbackHook(createMockContext(), { pluginConfig: basePluginConfig }, {
      createFirstPromptWatchdog: (_deps, _helpers, configuredWatchdogMs) => {
        watchdogMs = configuredWatchdogMs
        return createRecordingWatchdog([])
      },
    })

    // then
    expect(watchdogMs).toBe(DEFAULT_CONFIG.first_progress_timeout_seconds * 1000)
  })

  test("#given runtime fallback timeout_seconds is configured #when the hook factory runs #then the first-prompt watchdog uses the configured timeout", () => {
    // given
    const configuredTimeoutSeconds = 300
    let watchdogMs: number | undefined

    // when
    createRuntimeFallbackHook(createMockContext(), {
      config: { enabled: true, timeout_seconds: configuredTimeoutSeconds },
      pluginConfig: basePluginConfig,
    }, {
      createFirstPromptWatchdog: (_deps, _helpers, configuredWatchdogMs) => {
        watchdogMs = configuredWatchdogMs
        return createRecordingWatchdog([])
      },
    })

    // then
    expect(watchdogMs).toBe(configuredTimeoutSeconds * 1000)
  })

  test("#given separate runtime fallback timeouts are configured #when the hook factory runs #then the resolved config keeps legacy timeout as first-progress alias only", () => {
    // given
    let resolvedConfig: HookDeps["config"] | undefined

    // when
    createRuntimeFallbackHook(createMockContext(), {
      config: {
        enabled: true,
        timeout_seconds: 300,
        stall_timeout_seconds: 900,
        hard_timeout_seconds: 1800,
      },
      pluginConfig: basePluginConfig,
    }, {
      createAutoRetryHelpers: (deps) => {
        resolvedConfig = deps.config
        return createRecordingHelpers([])
      },
    })

    // then
    expect(resolvedConfig?.timeout_seconds).toBe(300)
    expect(resolvedConfig?.first_progress_timeout_seconds).toBe(300)
    expect(resolvedConfig?.stall_timeout_seconds).toBe(900)
    expect(resolvedConfig?.hard_timeout_seconds).toBe(1800)
  })

  test("#given timeout_seconds is zero #when newer timeout fields are omitted #then timeout fallback remains disabled", () => {
    // given
    let resolvedConfig: HookDeps["config"] | undefined

    // when
    createRuntimeFallbackHook(createMockContext(), {
      config: { enabled: true, timeout_seconds: 0 },
      pluginConfig: basePluginConfig,
    }, {
      createAutoRetryHelpers: (deps) => {
        resolvedConfig = deps.config
        return createRecordingHelpers([])
      },
    })

    // then
    expect(resolvedConfig?.first_progress_timeout_seconds).toBe(0)
    expect(resolvedConfig?.stall_timeout_seconds).toBe(0)
    expect(resolvedConfig?.hard_timeout_seconds).toBe(0)
  })

  test("#given a fresh hook #when the first event arrives #then cleanup interval starts only once", async () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext(), { pluginConfig: basePluginConfig })

    // when
    expect(setIntervalCalls).toBe(0)
    await hook.event({ event: { type: "session.created", properties: {} } })
    expect(setIntervalCalls).toBe(1)
    await hook.event({ event: { type: "session.error", properties: {} } })

    // then
    expect(setIntervalCalls).toBe(1)
  })

  test("#given tool.execute.before carries a sessionID #when the hook observes it #then fallback and first-prompt watchdog progress are both refreshed", async () => {
    // given
    const sessionID = "session-tool-before"
    const refreshCalls: Array<{ sessionID: string; source: string }> = []
    const progressCalls: string[] = []
    const hook = createRuntimeFallbackHook(createMockContext(), { config: { enabled: true }, pluginConfig: basePluginConfig }, {
      createAutoRetryHelpers: () => createRecordingHelpers(refreshCalls),
      createFirstPromptWatchdog: () => createRecordingWatchdog(progressCalls),
    })

    // when
    await hook["tool.execute.before"]?.({ tool: "read", sessionID, callID: "call-before" }, {})

    // then
    expect(refreshCalls).toEqual([{ sessionID, source: "tool.execute.before:read" }])
    expect(progressCalls).toEqual([sessionID])
  })

  test("#given tool.execute.after carries a sessionID #when the hook observes it #then fallback and first-prompt watchdog progress are both refreshed", async () => {
    // given
    const sessionID = "session-tool-after"
    const refreshCalls: Array<{ sessionID: string; source: string }> = []
    const progressCalls: string[] = []
    const hook = createRuntimeFallbackHook(createMockContext(), { config: { enabled: true }, pluginConfig: basePluginConfig }, {
      createAutoRetryHelpers: () => createRecordingHelpers(refreshCalls),
      createFirstPromptWatchdog: () => createRecordingWatchdog(progressCalls),
    })

    // when
    await hook["tool.execute.after"]?.({ tool: "serena_search_for_pattern", sessionID, callID: "call-after" }, {})

    // then
    expect(refreshCalls).toEqual([{ sessionID, source: "tool.execute.after:serena_search_for_pattern" }])
    expect(progressCalls).toEqual([sessionID])
  })

  test("#given runtime fallback is disabled #when tool progress arrives #then no fallback or watchdog progress is refreshed", async () => {
    // given
    const refreshCalls: Array<{ sessionID: string; source: string }> = []
    const progressCalls: string[] = []
    const hook = createRuntimeFallbackHook(createMockContext(), { config: { enabled: false }, pluginConfig: basePluginConfig }, {
      createAutoRetryHelpers: () => createRecordingHelpers(refreshCalls),
      createFirstPromptWatchdog: () => createRecordingWatchdog(progressCalls),
    })

    // when
    await hook["tool.execute.before"]?.({ tool: "read", sessionID: "session-disabled" }, {})

    // then
    expect(refreshCalls).toEqual([])
    expect(progressCalls).toEqual([])
  })

  test("#given tool progress has no sessionID #when the hook observes it #then no fallback or watchdog progress is refreshed", async () => {
    // given
    const refreshCalls: Array<{ sessionID: string; source: string }> = []
    const progressCalls: string[] = []
    const hook = createRuntimeFallbackHook(createMockContext(), { config: { enabled: true }, pluginConfig: basePluginConfig }, {
      createAutoRetryHelpers: () => createRecordingHelpers(refreshCalls),
      createFirstPromptWatchdog: () => createRecordingWatchdog(progressCalls),
    })

    // when
    await hook["tool.execute.after"]?.({ tool: "read", sessionID: "" }, {})

    // then
    expect(refreshCalls).toEqual([])
    expect(progressCalls).toEqual([])
  })

  // Real timers are the test-discipline exception here: the watchdog timer's
  // cancellation IS the system under test, so the real `createFirstPromptWatchdog`
  // runs and we wait past the configured timeout to prove it was cancelled
  // (vs. merely reset). Same exception as first-prompt-watchdog.test.ts.

  const REAL_WATCHDOG_AGENT = "sisyphus-junior"
  const REAL_WATCHDOG_PRIMARY_MODEL = "openai/gpt-5.4-mini"
  const REAL_WATCHDOG_FALLBACK_MODEL = "anthropic/claude-haiku-4-5"
  const REAL_WATCHDOG_TIMEOUT_SECONDS = 0.1
  const REAL_WATCHDOG_WAIT_PAST_FIRE_MS = 250

  const realWatchdogPluginConfig: OhMyOpenCodeConfig = {
    git_master: {
      commit_footer: true,
      include_co_authored_by: true,
      git_env_prefix: "GIT_MASTER=1",
    },
    agents: {
      [REAL_WATCHDOG_AGENT]: {
        model: REAL_WATCHDOG_PRIMARY_MODEL,
        fallback_models: [{ model: REAL_WATCHDOG_FALLBACK_MODEL }],
      },
    },
  }

  interface RealWatchdogCalls {
    refresh: Array<{ sessionID: string; source: string }>
    abort: Array<{ sessionID: string; source: string }>
    autoRetry: Array<{ sessionID: string; newModel: string; resolvedAgent: string | undefined; source: string }>
  }

  function createRealWatchdogHelpers(calls: RealWatchdogCalls, resolvedAgentName: string): AutoRetryHelpers {
    return {
      abortSessionRequest: async (sessionID, source) => {
        calls.abort.push({ sessionID, source })
      },
      clearSessionFallbackTimeout: () => {},
      clearSessionFallbackState: () => {},
      scheduleSessionFallbackTimeout: () => {},
      refreshSessionFallbackTimeout: (sessionID, source) => {
        calls.refresh.push({ sessionID, source })
        return false
      },
      autoRetryWithFallback: async (sessionID, newModel, resolvedAgent, source) => {
        calls.autoRetry.push({ sessionID, newModel, resolvedAgent, source })
      },
      resolveAgentForSessionFromContext: async () => resolvedAgentName,
      cleanupStaleSessions: () => {},
    }
  }

  function waitPastRealWatchdog(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, REAL_WATCHDOG_WAIT_PAST_FIRE_MS))
  }

  async function armRealWatchdogViaUserMessage(
    hook: ReturnType<typeof createRuntimeFallbackHook>,
    sessionID: string,
  ): Promise<void> {
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID,
            role: "user",
            model: REAL_WATCHDOG_PRIMARY_MODEL,
            agent: REAL_WATCHDOG_AGENT,
          },
        },
      },
    })
  }

  test("#given the real first-prompt watchdog is armed for a subagent #when tool.execute.before arrives with the sessionID before the timeout #then the real watchdog timer is cancelled and no abort or fallback dispatch occurs", async () => {
    // given
    const sessionID = "session-tool-before-cancels-real-watchdog"
    subagentSessions.add(sessionID)
    const calls: RealWatchdogCalls = { refresh: [], abort: [], autoRetry: [] }
    const hook = createRuntimeFallbackHook(
      createMockContext(),
      {
        config: { enabled: true, timeout_seconds: REAL_WATCHDOG_TIMEOUT_SECONDS },
        pluginConfig: realWatchdogPluginConfig,
      },
      {
        createAutoRetryHelpers: () => createRealWatchdogHelpers(calls, REAL_WATCHDOG_AGENT),
      },
    )

    // when
    await armRealWatchdogViaUserMessage(hook, sessionID)
    await hook["tool.execute.before"]?.({ tool: "read", sessionID, callID: "call-real-before" }, {})
    await waitPastRealWatchdog()

    // then
    expect(calls.refresh).toEqual([{ sessionID, source: "tool.execute.before:read" }])
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    hook.dispose?.()
  })

  test("#given the real first-prompt watchdog already observed tool progress #when a later synthetic user message arrives before terminal #then the watchdog is not rearmed", async () => {
    // given
    const sessionID = "session-tool-progress-blocks-rearm"
    subagentSessions.add(sessionID)
    const calls: RealWatchdogCalls = { refresh: [], abort: [], autoRetry: [] }
    const hook = createRuntimeFallbackHook(
      createMockContext(),
      {
        config: { enabled: true, timeout_seconds: REAL_WATCHDOG_TIMEOUT_SECONDS },
        pluginConfig: realWatchdogPluginConfig,
      },
      {
        createAutoRetryHelpers: () => createRealWatchdogHelpers(calls, REAL_WATCHDOG_AGENT),
      },
    )

    // when
    await armRealWatchdogViaUserMessage(hook, sessionID)
    await hook["tool.execute.before"]?.({ tool: "read", sessionID, callID: "call-real-before" }, {})
    await armRealWatchdogViaUserMessage(hook, sessionID)
    await waitPastRealWatchdog()

    // then
    expect(calls.refresh).toEqual([{ sessionID, source: "tool.execute.before:read" }])
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    hook.dispose?.()
  })

  test("#given the real first-prompt watchdog is armed for a subagent #when tool.execute.after arrives with the sessionID before the timeout #then the real watchdog timer is cancelled and no abort or fallback dispatch occurs", async () => {
    // given
    const sessionID = "session-tool-after-cancels-real-watchdog"
    subagentSessions.add(sessionID)
    const calls: RealWatchdogCalls = { refresh: [], abort: [], autoRetry: [] }
    const hook = createRuntimeFallbackHook(
      createMockContext(),
      {
        config: { enabled: true, timeout_seconds: REAL_WATCHDOG_TIMEOUT_SECONDS },
        pluginConfig: realWatchdogPluginConfig,
      },
      {
        createAutoRetryHelpers: () => createRealWatchdogHelpers(calls, REAL_WATCHDOG_AGENT),
      },
    )

    // when
    await armRealWatchdogViaUserMessage(hook, sessionID)
    await hook["tool.execute.after"]?.({ tool: "serena_search_for_pattern", sessionID, callID: "call-real-after" }, {})
    await waitPastRealWatchdog()

    // then
    expect(calls.refresh).toEqual([{ sessionID, source: "tool.execute.after:serena_search_for_pattern" }])
    expect(calls.abort).toEqual([])
    expect(calls.autoRetry).toEqual([])

    hook.dispose?.()
  })

  test("#given the real first-prompt watchdog is armed for a subagent #when no tool.execute event arrives before the timeout #then the real watchdog aborts the in-flight request and dispatches the fallback retry", async () => {
    // given
    const sessionID = "session-no-tool-progress-real-watchdog"
    subagentSessions.add(sessionID)
    const calls: RealWatchdogCalls = { refresh: [], abort: [], autoRetry: [] }
    const hook = createRuntimeFallbackHook(
      createMockContext(),
      {
        config: { enabled: true, timeout_seconds: REAL_WATCHDOG_TIMEOUT_SECONDS },
        pluginConfig: realWatchdogPluginConfig,
      },
      {
        createAutoRetryHelpers: () => createRealWatchdogHelpers(calls, REAL_WATCHDOG_AGENT),
      },
    )

    // when
    await armRealWatchdogViaUserMessage(hook, sessionID)
    await waitPastRealWatchdog()

    // then
    expect(calls.refresh).toEqual([])
    expect(calls.abort).toEqual([{ sessionID, source: "first-prompt-watchdog" }])
    expect(calls.autoRetry).toHaveLength(1)
    expect(calls.autoRetry[0]?.sessionID).toBe(sessionID)
    expect(calls.autoRetry[0]?.newModel).toBe(REAL_WATCHDOG_FALLBACK_MODEL)
    expect(calls.autoRetry[0]?.resolvedAgent).toBe(REAL_WATCHDOG_AGENT)
    expect(calls.autoRetry[0]?.source).toBe("first-prompt-watchdog")

    hook.dispose?.()
  })
})

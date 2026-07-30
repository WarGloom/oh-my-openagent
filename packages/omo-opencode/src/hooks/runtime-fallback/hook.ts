import { createAutoRetryHelpers } from "./auto-retry"
import { createChatMessageHandler } from "./chat-message-handler"
import { DEFAULT_CONFIG } from "./constants"
import { createEventHandler } from "./event-handler"
import { createFirstPromptWatchdog, observeEventForWatchdog } from "./first-prompt-watchdog"
import { createMessageUpdateHandler } from "./message-update-handler"
import type { HookDeps, RuntimeFallbackHook, RuntimeFallbackInterval, RuntimeFallbackOptions, RuntimeFallbackPluginInput, RuntimeFallbackTimeout } from "./types"

declare function setInterval(callback: () => void, delay?: number): RuntimeFallbackInterval
declare function clearInterval(interval: RuntimeFallbackInterval): void
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

type RuntimeFallbackHookFactories = {
  createAutoRetryHelpers: typeof createAutoRetryHelpers
  createEventHandler: typeof createEventHandler
  createMessageUpdateHandler: typeof createMessageUpdateHandler
  createChatMessageHandler: typeof createChatMessageHandler
  createFirstPromptWatchdog: typeof createFirstPromptWatchdog
}

const defaultRuntimeFallbackHookFactories: RuntimeFallbackHookFactories = {
  createAutoRetryHelpers,
  createEventHandler,
  createMessageUpdateHandler,
  createChatMessageHandler,
  createFirstPromptWatchdog,
}

export function createRuntimeFallbackHook(
  ctx: RuntimeFallbackPluginInput,
  options?: RuntimeFallbackOptions,
  factoryOverrides: Partial<RuntimeFallbackHookFactories> = {},
): RuntimeFallbackHook {
  const factories = {
    ...defaultRuntimeFallbackHookFactories,
    ...factoryOverrides,
  }
  const configuredTimeoutSeconds = options?.config?.timeout_seconds
  const legacyTimeoutSeconds = configuredTimeoutSeconds ?? DEFAULT_CONFIG.timeout_seconds
  const legacyTimeoutDisabled = configuredTimeoutSeconds === 0
  const firstProgressTimeoutSeconds = options?.config?.first_progress_timeout_seconds ?? legacyTimeoutSeconds
  const config = {
    enabled: options?.config?.enabled ?? DEFAULT_CONFIG.enabled,
    retry_on_errors: options?.config?.retry_on_errors ?? DEFAULT_CONFIG.retry_on_errors,
    max_fallback_attempts: options?.config?.max_fallback_attempts ?? DEFAULT_CONFIG.max_fallback_attempts,
    cooldown_seconds: options?.config?.cooldown_seconds ?? DEFAULT_CONFIG.cooldown_seconds,
    timeout_seconds: legacyTimeoutSeconds,
    first_progress_timeout_seconds: firstProgressTimeoutSeconds,
    stall_timeout_seconds: options?.config?.stall_timeout_seconds ?? (legacyTimeoutDisabled ? 0 : DEFAULT_CONFIG.stall_timeout_seconds),
    hard_timeout_seconds: options?.config?.hard_timeout_seconds ?? (legacyTimeoutDisabled ? 0 : DEFAULT_CONFIG.hard_timeout_seconds),
    notify_on_fallback: options?.config?.notify_on_fallback ?? DEFAULT_CONFIG.notify_on_fallback,
    restore_primary_after_cooldown: options?.config?.restore_primary_after_cooldown ?? DEFAULT_CONFIG.restore_primary_after_cooldown,
  }

  const deps: HookDeps = {
    ctx,
    config,
    options,
    pluginConfig: options?.pluginConfig,
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

  const helpers = factories.createAutoRetryHelpers(deps)
  const baseEventHandler = factories.createEventHandler(deps, helpers)
  const messageUpdateHandler = factories.createMessageUpdateHandler(deps, helpers)
  const chatMessageHandler = factories.createChatMessageHandler(deps)
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(
    deps,
    helpers,
    config.first_progress_timeout_seconds * 1000,
  )

  let cleanupInterval: RuntimeFallbackInterval | null = null
  let intervalStarted = false

  const ensureInterval = (): void => {
    if (intervalStarted) return

    intervalStarted = true
    cleanupInterval = setInterval(helpers.cleanupStaleSessions, 5 * 60 * 1000)

    if (typeof cleanupInterval.unref === "function") {
      cleanupInterval.unref()
    }
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    ensureInterval()

    if (config.enabled) {
      const progressSessionID = observeEventForWatchdog(event, firstPromptWatchdog)
      if (progressSessionID && event.type !== "message.updated") {
        helpers.refreshSessionFallbackTimeout(progressSessionID, `${event.type}.progress`)
      }
    }

    if (event.type === "message.updated") {
      if (!config.enabled) return
      const props = event.properties as Record<string, unknown> | undefined
      await messageUpdateHandler(props)
      return
    }
    await baseEventHandler({ event })
  }

  const refreshAfterToolProgress = async (
    input: { tool: string; sessionID: string; callID?: string },
    source: "tool.execute.before" | "tool.execute.after",
  ): Promise<void> => {
    if (!config.enabled || !input.sessionID) return

    helpers.refreshSessionFallbackTimeout(input.sessionID, `${source}:${input.tool}`)
    firstPromptWatchdog.onAssistantProgress(input.sessionID)
  }

  const dispose = () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval)
    }

    for (const fallbackTimeout of deps.sessionFallbackTimeouts.values()) {
      clearTimeout(fallbackTimeout)
    }
    for (const fallbackTimeout of deps.sessionFallbackHardTimeouts.values()) {
      clearTimeout(fallbackTimeout)
    }

    firstPromptWatchdog.dispose()

    deps.sessionStates.clear()
    deps.sessionLastAccess.clear()
    deps.sessionRetryInFlight.clear()
    deps.sessionAwaitingFallbackResult.clear()
    deps.sessionFallbackAbortInFlight.clear()
    deps.sessionFallbackTimeouts.clear()
    deps.sessionFallbackHardTimeouts.clear()
    deps.sessionFallbackTimeoutAgents.clear()
    deps.sessionFallbackTimeoutKinds.clear()
    deps.sessionFallbackProgressObserved.clear()
    deps.sessionFallbackUnsafeToReplay.clear()
    deps.sessionStatusRetryKeys.clear()
    deps.internallyAbortedSessions.clear()
  }

  return {
    event: eventHandler,
    "chat.message": chatMessageHandler,
    "tool.execute.before": async (input, _output) => {
      await refreshAfterToolProgress(input, "tool.execute.before")
    },
    "tool.execute.after": async (input, _output) => {
      await refreshAfterToolProgress(input, "tool.execute.after")
    },
    dispose,
  } as RuntimeFallbackHook
}

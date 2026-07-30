import type { AutoRetryDispatchOutcome, HookDeps, RuntimeFallbackTimeout } from "./types"
import { createAbortSessionRequest } from "./auto-retry-abort"
import { createAgentContextResolver } from "./auto-retry-agent-context"
import { createAutoRetryDispatcher } from "./auto-retry-dispatch"
import { createFallbackTimeoutHelpers } from "./auto-retry-timeout"
import { createStaleSessionCleanup } from "./auto-retry-cleanup"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"

declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

type AutoRetryFallbackCallbacks = {
  onPromptFailedBeforeAccept?: () => void
  onPromptNotAccepted?: () => void
  onPromptAccepted?: () => Promise<void> | void
}

type AutoRetryWithFallback = (
  sessionID: string,
  newModel: string,
  resolvedAgent: string | undefined,
  source: string,
  callbacks?: AutoRetryFallbackCallbacks,
) => Promise<AutoRetryDispatchOutcome>

export function createAutoRetryHelpers(deps: HookDeps) {
  const abortSessionRequest = createAbortSessionRequest(deps)
  let dispatchAutoRetryWithFallback: ReturnType<typeof createAutoRetryDispatcher>
  const autoRetryWithFallback: AutoRetryWithFallback = (sessionID, newModel, resolvedAgent, source, callbacks) =>
    dispatchAutoRetryWithFallback(sessionID, newModel, resolvedAgent, source, callbacks)

  const timeoutHelpers = createFallbackTimeoutHelpers(
    deps,
    abortSessionRequest,
    (sessionID, newModel, resolvedAgent, source, callbacks) =>
      autoRetryWithFallback(sessionID, newModel, resolvedAgent, source, callbacks),
  )
  const { clearSessionFallbackTimeout } = timeoutHelpers

  const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent?: string): void => {
    deps.sessionFallbackTimeoutAgents.set(sessionID, resolvedAgent)
    timeoutHelpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
  }

  const clearSessionFallbackState = (sessionID: string): void => {
    clearSessionFallbackTimeout(sessionID)
    const hardTimer = deps.sessionFallbackHardTimeouts.get(sessionID)
    if (hardTimer) {
      clearTimeout(hardTimer)
      deps.sessionFallbackHardTimeouts.delete(sessionID)
    }
    deps.sessionFallbackTimeoutAgents.delete(sessionID)
    deps.sessionFallbackTimeoutKinds.delete(sessionID)
    deps.sessionFallbackProgressObserved.delete(sessionID)
    deps.sessionFallbackUnsafeToReplay.delete(sessionID)
    deps.internallyAbortedSessions.delete(sessionID)
  }

  const refreshSessionFallbackTimeout = (sessionID: string, source: string): boolean => {
    deps.sessionLastAccess.set(sessionID, Date.now())
    if (source.startsWith("tool.execute.")) {
      deps.sessionFallbackUnsafeToReplay.add(sessionID)
    }

    if (!deps.sessionAwaitingFallbackResult.has(sessionID)) {
      return false
    }

    deps.sessionFallbackProgressObserved.add(sessionID)
    scheduleSessionFallbackTimeout(sessionID, deps.sessionFallbackTimeoutAgents.get(sessionID))
    log(`[${HOOK_NAME}] Refreshed fallback stall timeout`, { sessionID, source })
    return true
  }

  dispatchAutoRetryWithFallback = createAutoRetryDispatcher(
    deps,
    scheduleSessionFallbackTimeout,
    clearSessionFallbackTimeout,
  )

  return {
    abortSessionRequest,
    clearSessionFallbackTimeout,
    clearSessionFallbackState,
    scheduleSessionFallbackTimeout,
    refreshSessionFallbackTimeout,
    autoRetryWithFallback,
    resolveAgentForSessionFromContext: createAgentContextResolver(deps),
    cleanupStaleSessions: createStaleSessionCleanup(deps, clearSessionFallbackTimeout),
  }
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>

import type { HookDeps, RuntimeFallbackTimeout } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { clearDelegatedChildSessionBootstrap } from "../../shared/delegated-child-session-bootstrap"

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

export function createStaleSessionCleanup(
  deps: HookDeps,
  clearSessionFallbackTimeout: (sessionID: string) => void,
) {
  const {
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackAbortInFlight,
    sessionFallbackHardTimeouts,
    sessionFallbackTimeoutAgents,
    sessionFallbackTimeoutKinds,
    sessionFallbackProgressObserved,
    sessionFallbackUnsafeToReplay,
    sessionStatusRetryKeys,
    internallyAbortedSessions,
  } = deps

  return () => {
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        const hardTimer = sessionFallbackHardTimeouts.get(sessionID)
        if (hardTimer) {
          clearTimeout(hardTimer)
          sessionFallbackHardTimeouts.delete(sessionID)
        }
        sessionStates.delete(sessionID)
        sessionLastAccess.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionFallbackAbortInFlight.delete(sessionID)
        sessionFallbackTimeoutAgents.delete(sessionID)
        sessionFallbackTimeoutKinds.delete(sessionID)
        sessionFallbackProgressObserved.delete(sessionID)
        sessionFallbackUnsafeToReplay.delete(sessionID)
        internallyAbortedSessions.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        clearDelegatedChildSessionBootstrap(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        cleanedCount++
      }
    }
    if (cleanedCount > 0) {
      log(`[${HOOK_NAME}] Cleaned up ${cleanedCount} stale session states`)
    }
  }
}

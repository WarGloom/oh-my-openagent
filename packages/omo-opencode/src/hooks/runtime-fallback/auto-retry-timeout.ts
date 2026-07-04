import type { AutoRetryDispatchOutcome, HookDeps, RuntimeFallbackTimeout } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { getFallbackModelsForSession } from "./fallback-models"
import { prepareFallback } from "./fallback-state"
import { restoreFallbackState, snapshotFallbackState } from "./fallback-state-snapshot"
import { subagentSessions } from "../../features/claude-code-session-state"

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

export function createFallbackTimeoutHelpers(
  deps: HookDeps,
  abortSessionRequest: (sessionID: string, source: string) => Promise<void>,
  autoRetryWithFallback: (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    callbacks?: {
      onPromptFailedBeforeAccept?: () => void
      onPromptNotAccepted?: () => void
      onPromptAccepted?: () => Promise<void> | void
    },
  ) => Promise<AutoRetryDispatchOutcome>,
) {
  const {
    config,
    options,
    sessionStates,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts,
    sessionFallbackHardTimeouts,
    sessionFallbackTimeoutKinds,
    sessionFallbackProgressObserved,
    sessionFallbackUnsafeToReplay,
    pluginConfig,
  } = deps

  const clearSessionFallbackTimeout = (sessionID: string) => {
    const timer = sessionFallbackTimeouts.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      sessionFallbackTimeouts.delete(sessionID)
    }
    sessionFallbackTimeoutKinds.delete(sessionID)
  }

  const abortWithoutReplay = async (sessionID: string, timeoutKind: "stall" | "hard") => {
    const state = sessionStates.get(sessionID)
    if (!state) return

    await abortSessionRequest(sessionID, "session.timeout")
    sessionRetryInFlight.delete(sessionID)
    sessionAwaitingFallbackResult.delete(sessionID)

    const message = timeoutKind === "hard"
      ? "Session fallback hard timeout reached after tool progress"
      : "Session fallback timeout reached after tool progress; aborting without auto-replay"
    log(`[${HOOK_NAME}] ${message}`, {
      sessionID,
      timeoutKind,
      currentModel: state.currentModel,
    })
  }

  const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent?: string) => {
    clearSessionFallbackTimeout(sessionID)

    const hardTimeoutMs = config.hard_timeout_seconds * 1000
    if (hardTimeoutMs > 0 && !sessionFallbackHardTimeouts.has(sessionID)) {
      const hardTimer = setTimeout(async () => {
        sessionFallbackHardTimeouts.delete(sessionID)
        if (sessionFallbackUnsafeToReplay.has(sessionID)) {
          await abortWithoutReplay(sessionID, "hard")
          return
        }
      }, hardTimeoutMs)
      sessionFallbackHardTimeouts.set(sessionID, hardTimer)
    }

    const timeoutKind = sessionFallbackProgressObserved.has(sessionID) ? "stall" : "first-progress"
    const configuredTimeoutSeconds = timeoutKind === "first-progress"
      ? (config.first_progress_timeout_seconds > 0 ? config.first_progress_timeout_seconds : config.timeout_seconds)
      : config.stall_timeout_seconds
    const timeoutMs = options?.session_timeout_ms ?? configuredTimeoutSeconds * 1000
    if (timeoutMs <= 0) return
    const wasSubagentSession = subagentSessions.has(sessionID)

    sessionFallbackTimeoutKinds.set(sessionID, timeoutKind)
    const timer = setTimeout(async () => {
      sessionFallbackTimeouts.delete(sessionID)
      sessionFallbackTimeoutKinds.delete(sessionID)

      if (wasSubagentSession && !subagentSessions.has(sessionID)) {
        log(`[${HOOK_NAME}] Session fallback timeout skipped for completed subagent`, { sessionID })
        return
      }

      const state = sessionStates.get(sessionID)
      if (!state) return

      if (sessionRetryInFlight.has(sessionID)) {
        log(`[${HOOK_NAME}] Overriding in-flight retry due to session timeout`, { sessionID })
      }

      if (sessionFallbackUnsafeToReplay.has(sessionID)) {
        await abortWithoutReplay(sessionID, "stall")
        return
      }

      const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)

      await abortSessionRequest(sessionID, "session.timeout")
      sessionRetryInFlight.delete(sessionID)
      sessionAwaitingFallbackResult.delete(sessionID)

      const stateSnapshot = snapshotFallbackState(state)
      const restorePreparedFallbackState = () => {
        restoreFallbackState(state, stateSnapshot)
      }

      if (state.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }
      state.pendingFallbackPromptMayHaveBeenAccepted = false

      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
      if (fallbackModels.length === 0) return

      log(`[${HOOK_NAME}] Session fallback timeout reached`, {
        sessionID,
        timeoutKind,
        timeoutMs,
        currentModel: state.currentModel,
      })

      const result = prepareFallback(sessionID, state, fallbackModels, config)
      if (result.success && result.newModel) {
        const dispatchOutcome = await autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, "session.timeout", {
          onPromptFailedBeforeAccept: restorePreparedFallbackState,
          onPromptNotAccepted: restorePreparedFallbackState,
        })
        if (!dispatchOutcome.accepted) {
          restoreFallbackState(state, stateSnapshot)
          if (wasAwaitingFallbackResult) {
            sessionAwaitingFallbackResult.add(sessionID)
            scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
          }
          log(`[${HOOK_NAME}] Session timeout fallback dispatch was not accepted`, {
            sessionID,
            status: dispatchOutcome.status,
            reason: dispatchOutcome.reason,
          })
        }
      }
    }, timeoutMs)

    sessionFallbackTimeouts.set(sessionID, timer)
  }

  return {
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
  }
}

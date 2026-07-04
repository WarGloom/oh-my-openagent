import type { AutoRetryHelpers } from "./auto-retry"
import type { AutoRetryDispatchOutcome, HookDeps, FallbackState } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { prepareFallback } from "./fallback-state"
import { restoreFallbackState, snapshotFallbackState } from "./fallback-state-snapshot"

type DispatchFallbackRetryOptions = {
  sessionID: string
  state: FallbackState
  fallbackModels: string[]
  resolvedAgent?: string
  source: string
}

function suppressUnsafeAutoReplay(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  options: DispatchFallbackRetryOptions,
): boolean {
  if (!deps.sessionFallbackUnsafeToReplay.has(options.sessionID)) return false

  deps.sessionRetryInFlight.delete(options.sessionID)
  deps.sessionAwaitingFallbackResult.delete(options.sessionID)
  deps.sessionFallbackAbortInFlight.delete(options.sessionID)
  deps.sessionStatusRetryKeys.delete(options.sessionID)
  helpers.clearSessionFallbackTimeout(options.sessionID)
  options.state.pendingFallbackModel = undefined
  options.state.pendingFallbackPromptMayHaveBeenAccepted = false

  log(`[${HOOK_NAME}] Skipping automatic fallback replay after tool progress`, {
    sessionID: options.sessionID,
    source: options.source,
    currentModel: options.state.currentModel,
  })
  return true
}

function resolveDispatchMessage(result: AutoRetryDispatchOutcome, newModel: string): string {
  const modelName = newModel.split("/").pop() || newModel
  if (result.status === "queued") return `Fallback queued for ${modelName}`
  if (result.status === "possibly-accepted") return `Fallback dispatch may have been accepted for ${modelName}`
  return `Switched to ${modelName} for next request`
}

async function showFallbackToast(deps: HookDeps, sessionID: string, message: string): Promise<void> {
  if (!deps.config.notify_on_fallback) return

  try {
    await deps.ctx.client.tui.showToast({
      body: {
        title: "Model Fallback",
        message,
        variant: "warning",
        duration: 5000,
      },
    })
  } catch (error) {
    log(`[${HOOK_NAME}] Failed to show fallback toast`, {
      sessionID,
      error: String(error),
    })
  }
}

export async function dispatchFallbackRetry(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  options: DispatchFallbackRetryOptions,
): Promise<void> {
  if (suppressUnsafeAutoReplay(deps, helpers, options)) return

  const snapshot = snapshotFallbackState(options.state)
  const result = prepareFallback(
    options.sessionID,
    options.state,
    options.fallbackModels,
    deps.config,
  )

  if (result.success && result.newModel) {
    const newModel = result.newModel
    const rawDispatchOutcome = (await helpers.autoRetryWithFallback(
      options.sessionID,
      newModel,
      options.resolvedAgent,
      options.source,
      {
        onPromptFailedBeforeAccept: () => restoreFallbackState(options.state, snapshot),
        onPromptNotAccepted: () => restoreFallbackState(options.state, snapshot),
      },
    )) as unknown as AutoRetryDispatchOutcome | undefined

    const dispatchOutcome = rawDispatchOutcome ?? {
      accepted: true,
      status: "dispatched",
    }
    if (rawDispatchOutcome === undefined) {
      log(`[${HOOK_NAME}] Fallback dispatch returned no outcome; treating as accepted for compatibility`, {
        sessionID: options.sessionID,
        source: options.source,
      })
    }
    if (!dispatchOutcome.accepted) {
      restoreFallbackState(options.state, snapshot)
      log(`[${HOOK_NAME}] Fallback dispatch was not accepted`, {
        sessionID: options.sessionID,
        source: options.source,
        status: dispatchOutcome.status,
        reason: dispatchOutcome.reason,
      })
      return
    }

    await showFallbackToast(deps, options.sessionID, resolveDispatchMessage(dispatchOutcome, newModel))
    return
  }

  if (result.maxAttemptsReached) {
    deps.sessionRetryInFlight.delete(options.sessionID)
    deps.sessionAwaitingFallbackResult.delete(options.sessionID)
    deps.sessionFallbackAbortInFlight.delete(options.sessionID)
    helpers.clearSessionFallbackTimeout(options.sessionID)

    const state = deps.sessionStates.get(options.sessionID)
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined
    }

    log(`[${HOOK_NAME}] Fallback attempts exhausted; aborting session`, {
      sessionID: options.sessionID,
      source: options.source,
      error: result.error,
    })

    await helpers.abortSessionRequest(options.sessionID, "runtime-fallback:max-attempts")
    return
  }

  deps.sessionFallbackAbortInFlight.delete(options.sessionID)

  log(`[${HOOK_NAME}] Fallback preparation failed`, {
    sessionID: options.sessionID,
    source: options.source,
    error: result.error,
  })
}

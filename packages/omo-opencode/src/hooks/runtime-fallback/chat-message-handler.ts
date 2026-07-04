import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { createFallbackState, isModelInCooldown } from "./fallback-state"
import { parseModelString } from "../../shared/model-string-parser"
import { markRuntimeFallbackModelOverride } from "../../shared/runtime-fallback-model-override-marker"
import { setSessionModel } from "../../shared/session-model-state"
import { stringifyRuntimeFallbackModel } from "./model-input"
import { modelIdentity } from "./model-identity"

type ClearableTimeout = Parameters<typeof clearTimeout>[0]

function clearRuntimeFallbackTimeout(timeout: object | number): void {
  clearTimeout(timeout as ClearableTimeout)
}

export function createChatMessageHandler(deps: HookDeps) {
  const {
    config,
    sessionStates,
    sessionLastAccess,
    sessionAwaitingFallbackResult,
    sessionRetryInFlight,
    sessionFallbackAbortInFlight,
    sessionFallbackTimeouts,
    sessionFallbackHardTimeouts,
    sessionFallbackTimeoutAgents,
    sessionFallbackTimeoutKinds,
    sessionFallbackProgressObserved,
    sessionFallbackUnsafeToReplay,
    sessionStatusRetryKeys,
  } = deps

  return async (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: { model?: { providerID: string; modelID: string; variant?: string } }; parts?: Array<{ type: string; text?: string }> }
  ) => {
    if (!config.enabled) return

    const { sessionID } = input
    let state = sessionStates.get(sessionID)

    if (!state) return

    sessionLastAccess.set(sessionID, Date.now())

    const requestedModel = stringifyRuntimeFallbackModel(input.model)

    const requestedIdentity = modelIdentity(requestedModel)
    const currentIdentity = modelIdentity(state.currentModel)
    const originalIdentity = modelIdentity(state.originalModel)
    const pendingIdentity = modelIdentity(state.pendingFallbackModel)
    const requestedModelMatchesCurrent = Boolean(requestedIdentity && currentIdentity && requestedIdentity === currentIdentity)

    if (requestedModel && requestedIdentity && requestedIdentity !== currentIdentity) {
      if (pendingIdentity && pendingIdentity === requestedIdentity) {
        state.pendingFallbackModel = undefined
        state.pendingFallbackPromptMayHaveBeenAccepted = false
        return
      }

      const fallbackResultPending =
        sessionAwaitingFallbackResult.has(sessionID) || sessionFallbackTimeouts.has(sessionID)
      const requestedOriginalDuringActiveFallback =
        currentIdentity !== originalIdentity
        && requestedIdentity === originalIdentity
        && fallbackResultPending

      if (requestedOriginalDuringActiveFallback) {
        log(`[${HOOK_NAME}] Ignoring stale original model echo during active fallback`, {
          sessionID,
          requestedModel,
          activeModel: state.currentModel,
        })
      } else {
        log(`[${HOOK_NAME}] Detected manual model change, resetting fallback state`, {
          sessionID,
          from: state.currentModel,
          to: requestedModel,
        })
        const fallbackTimeout = sessionFallbackTimeouts.get(sessionID)
        if (fallbackTimeout) {
          clearRuntimeFallbackTimeout(fallbackTimeout)
        }
        const hardTimeout = sessionFallbackHardTimeouts.get(sessionID)
        if (hardTimeout) {
          clearRuntimeFallbackTimeout(hardTimeout)
        }
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionFallbackAbortInFlight.delete(sessionID)
        sessionFallbackTimeouts.delete(sessionID)
        sessionFallbackHardTimeouts.delete(sessionID)
        sessionFallbackTimeoutAgents.delete(sessionID)
        sessionFallbackTimeoutKinds.delete(sessionID)
        sessionFallbackProgressObserved.delete(sessionID)
        sessionFallbackUnsafeToReplay.delete(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        state = createFallbackState(requestedModel)
        sessionStates.set(sessionID, state)
        return
      }
    }

    // Variant-only echo of the same model: clear pending marker but do NOT
    // reset attemptCount or fallbackIndex (that reset is the loop bug).
    if (pendingIdentity && pendingIdentity === requestedIdentity) {
      state.pendingFallbackModel = undefined
      state.pendingFallbackPromptMayHaveBeenAccepted = false
      return
    }

    if (
      config.restore_primary_after_cooldown &&
      state.currentModel !== state.originalModel &&
      (!requestedModelMatchesCurrent || state.attemptCount === 0) &&
      !state.pendingFallbackModel &&
      !sessionAwaitingFallbackResult.has(sessionID) &&
      !sessionFallbackTimeouts.has(sessionID) &&
      !isModelInCooldown(state.originalModel, state, config.cooldown_seconds)
    ) {
      const activeModel = state.originalModel
      log(`[${HOOK_NAME}] Restoring preferred primary model`, {
        sessionID,
        from: state.currentModel,
        to: activeModel,
      })
      sessionStates.set(sessionID, createFallbackState(activeModel))

      const parts = activeModel.split("/")
      if (parts.length >= 2) {
        output.message.model = {
          providerID: parts[0],
          modelID: parts.slice(1).join("/"),
        }
      }
      return
    }

    if (currentIdentity === originalIdentity) return

    const activeModel = stringifyRuntimeFallbackModel(state.currentModel)
    if (!activeModel) return

    if (activeModel === state.originalModel) return

    log(`[${HOOK_NAME}] Applying fallback model override`, {
      sessionID,
      from: input.model,
      to: activeModel,
    })

    const parsedModel = parseModelString(activeModel)
    if (output.message && parsedModel) {
      output.message.model = {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        ...(parsedModel.variant ? { variant: parsedModel.variant } : {}),
      }
      setSessionModel(sessionID, {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
      })
      markRuntimeFallbackModelOverride(output.message)
    }
  }
}

import type { HookDeps } from "./types"
import type { RuntimeFallbackTimeout } from "./types"
import { parseModelString } from "@oh-my-opencode/model-core"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { createFallbackState, isModelInCooldown, stringifyRuntimeModelWithVariant } from "./fallback-state"
import { buildRetryModelPayload } from "./retry-model-payload"
import { resolveRuntimeModelSettings } from "./runtime-model-settings"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { markRuntimeFallbackModelOverride } from "../../shared/runtime-fallback-model-override-marker"
import { setSessionModel } from "../../shared/session-model-state"
import { modelIdentity } from "./model-identity"

declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

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

  function clearFallbackWatchdog(sessionID: string): void {
    sessionAwaitingFallbackResult.delete(sessionID)
    const timer = sessionFallbackTimeouts.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      sessionFallbackTimeouts.delete(sessionID)
    }
  }

  function clearModelLessRetryKeys(sessionID: string): void {
    const retryKeys = sessionStatusRetryKeys.get(sessionID)
    if (!(retryKeys instanceof Set)) return

    for (const retryKey of retryKeys) {
      if (retryKey.startsWith("unknown:")) {
        retryKeys.delete(retryKey)
      }
    }

    if (retryKeys.size === 0) {
      sessionStatusRetryKeys.delete(sessionID)
    }
  }

  function applyRuntimeModel(
    message: { model?: { providerID: string; modelID: string }; variant?: string },
    runtimeModel: string,
  ): void {
    const parsedModel = parseModelString(runtimeModel)
    if (!parsedModel) return

    message.model = {
      providerID: parsedModel.providerID,
      modelID: parsedModel.modelID,
    }

    if (parsedModel.variant) {
      message.variant = parsedModel.variant
    } else {
      delete message.variant
    }
  }

  return async (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
    },
    output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
      parts?: Array<{ type: string; text?: string }>
    },
  ) => {
    if (!config.enabled) return

    const { sessionID } = input
    let state = sessionStates.get(sessionID)

    if (!state) return

    sessionLastAccess.set(sessionID, Date.now())

    const requestedModel = stringifyRuntimeModelWithVariant(
      input.model,
      output.message.variant ?? input.variant,
    )

    const requestedIdentity = modelIdentity(requestedModel)
    const currentIdentity = modelIdentity(state.currentModel)
    const originalIdentity = modelIdentity(state.originalModel)
    const pendingIdentity = modelIdentity(state.pendingFallbackModel)

    const requestedModelMatchesCurrent = Boolean(
      requestedIdentity && currentIdentity && requestedIdentity === currentIdentity,
    )

    const requestedMatchesPending = Boolean(
      requestedModel &&
        (state.pendingFallbackModel === requestedModel ||
          (requestedIdentity &&
            pendingIdentity &&
            requestedIdentity === pendingIdentity)),
    )

    if (requestedMatchesPending) {
      state.pendingFallbackModel = undefined
      state.pendingFallbackPromptMayHaveBeenAccepted = false
      clearFallbackWatchdog(sessionID)
      clearModelLessRetryKeys(sessionID)
      return
    }

    const requestedDiffersFromCurrent = Boolean(
      requestedModel &&
        ((requestedIdentity &&
          currentIdentity &&
          requestedIdentity !== currentIdentity) ||
          (!requestedIdentity && requestedModel !== state.currentModel)),
    )

    if (requestedDiffersFromCurrent) {
      const fallbackResultPending =
        sessionAwaitingFallbackResult.has(sessionID) ||
        sessionFallbackTimeouts.has(sessionID)

      const requestedOriginalDuringActiveFallback =
        currentIdentity !== originalIdentity &&
        requestedIdentity === originalIdentity &&
        fallbackResultPending

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
          clearTimeout(fallbackTimeout)
        }

        const hardTimeout = sessionFallbackHardTimeouts.get(sessionID)
        if (hardTimeout) {
          clearTimeout(hardTimeout)
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

    if (
      config.restore_primary_after_cooldown &&
      state.currentModel !== state.originalModel &&
      (!requestedModelMatchesCurrent || state.attemptCount === 0) &&
      !state.pendingFallbackModel &&
      !sessionAwaitingFallbackResult.has(sessionID) &&
      !sessionFallbackTimeouts.has(sessionID) &&
      !isModelInCooldown(
        state.originalModel,
        state,
        config.cooldown_seconds,
      )
    ) {
      const primaryPayload = buildRetryModelPayload(
        state.originalModel,
        resolveRuntimeModelSettings(
          sessionID,
          input.agent ?? getSessionAgent(sessionID),
          deps.pluginConfig,
        ),
      )

      const activeModel = primaryPayload
        ? stringifyRuntimeModelWithVariant(
            primaryPayload.model,
            primaryPayload.variant,
          ) ?? state.originalModel
        : state.originalModel

      log(`[${HOOK_NAME}] Restoring preferred primary model`, {
        sessionID,
        from: state.currentModel,
        to: activeModel,
      })

      sessionStates.set(sessionID, createFallbackState(activeModel))
      applyRuntimeModel(output.message, activeModel)
      return
    }

    if (currentIdentity === originalIdentity) return

    const activeModel = stringifyRuntimeModelWithVariant(state.currentModel)
    if (!activeModel || activeModel === state.originalModel) return

    log(`[${HOOK_NAME}] Applying fallback model override`, {
      sessionID,
      from: input.model,
      to: activeModel,
    })

    applyRuntimeModel(output.message, activeModel)

    const parsedModel = parseModelString(activeModel)
    if (parsedModel) {
      setSessionModel(sessionID, {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
      })
      markRuntimeFallbackModelOverride(output.message)
    }
  }
}

import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME, RETRYABLE_ERROR_PATTERNS } from "./constants"
import { log } from "../../shared/logger"
import {
  classifyErrorType,
  extractAutoRetrySignal,
  isRetryableError,
  isUnavailableToolLikeError,
} from "./error-classifier"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { normalizeRetryStatusMessage, extractRetryAttempt } from "../../shared/retry-status-utils"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { modelIdentity } from "./model-identity"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { hasTimeoutDrivenFallbackEnabled } from "./timeout-config"
import { isDelegatedSessionOwnedByTask } from "./delegated-session-ownership"
import { normalizeModelToCanonicalString } from "./normalize-model"

const PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK = 1

function providerFromModel(model: unknown): string | undefined {
  const identity = modelIdentity(model)
  if (!identity) return undefined

  const separator = identity.indexOf("/")
  return separator > 0 ? identity.slice(0, separator) : undefined
}

function providerFromRetryMessage(message: string): string | undefined {
  const normalized = message.toLowerCase()
  if (
    normalized.includes("claude code returned an error result")
    || normalized.includes("custom betas are only available for api key users")
  ) {
    return "anthropic"
  }

  if (normalized.includes("generativelanguage.googleapis.com") || normalized.includes("gemini")) {
    return "google"
  }

  if (normalized.includes("help.openai.com") || normalized.includes("openai")) {
    return "openai"
  }

  return undefined
}

export function createSessionStatusHandler(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  sessionStatusRetryKeys: Map<string, string>,
) {
  const {
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
  } = deps

  return async (props: Record<string, unknown> | undefined) => {
    const sessionID = resolveSessionEventID(props)
    const status = props?.status as { type?: string; message?: string; attempt?: number } | undefined
    const agent = props?.agent as string | undefined
    const model = normalizeModelToCanonicalString(props?.model)
    const timeoutEnabled = hasTimeoutDrivenFallbackEnabled(deps.config)

    if (!sessionID || status?.type !== "retry") return

    if (isDelegatedSessionOwnedByTask(sessionID)) {
      log(`[${HOOK_NAME}] session.status retry skipped - delegated task owns fallback`, {
        sessionID,
        agent,
        model,
        retryAttempt: status.attempt,
      })
      return
    }

    const retryMessage = typeof status.message === "string" ? status.message : ""
    log(`[${HOOK_NAME}] session.status retry received`, {
      sessionID,
      agent,
      model,
      retryAttempt: status.attempt,
      hasMessage: retryMessage.length > 0,
      retryMessage,
    })

    if (isUnavailableToolLikeError(retryMessage)) {
      log(`[${HOOK_NAME}] session.status retry skipped - unavailable tool recovery in progress`, {
        sessionID,
        retryAttempt: status.attempt,
        retryMessage,
      })
      return
    }

    const retrySignal = extractAutoRetrySignal({ status: retryMessage, message: retryMessage })
    if (!retrySignal) {
      const messageLower = retryMessage.toLowerCase()
      const matchesRetryablePattern = RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(messageLower))
      const retryableBySharedClassifier = isRetryableError(
        { message: retryMessage, status: retryMessage },
        deps.config.retry_on_errors,
      )
      if (!matchesRetryablePattern && !retryableBySharedClassifier) {
        log(`[${HOOK_NAME}] session.status retry skipped - no retry signal or retryable pattern match`, {
          sessionID,
          retryAttempt: status.attempt,
          retryMessage,
        })
        if (retryMessage) {
          log(`[${HOOK_NAME}] session.status retry with non-matching message`, {
            sessionID,
            attempt: status.attempt,
            retryMessage,
          })
        }
        return
      }
    }

    const existingState = sessionStates.get(sessionID)
    const retryProvider = providerFromRetryMessage(retryMessage)
    const currentProvider = providerFromModel(existingState?.currentModel)
    if (retryProvider && currentProvider && retryProvider !== currentProvider) {
      log(`[${HOOK_NAME}] session.status retry skipped - provider attribution mismatch`, {
        sessionID,
        retryProvider,
        currentModel: existingState?.currentModel,
        currentProvider,
        eventModel: model,
        retryAttempt: status.attempt,
      })
      return
    }

    const retryAttempt = extractRetryAttempt(status.attempt, retryMessage)
    const isHardProviderExhaustion = classifyErrorType({
      name: "SessionRetry",
      message: retryMessage,
    }) === "quota_exceeded"
    const parsedRetryAttempt = Number.parseInt(retryAttempt, 10)
    if (
      !isHardProviderExhaustion
      && Number.isFinite(parsedRetryAttempt)
      && parsedRetryAttempt <= PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK
    ) {
      log(`[${HOOK_NAME}] session.status retry deferred to provider auto-retry`, {
        sessionID,
        retryAttempt,
        providerRetryAttemptsBeforeFallback: PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK,
        retryMessage,
      })
      return
    }

    const retryKey = `${retryAttempt}:${normalizeRetryStatusMessage(retryMessage)}`
    if (sessionStatusRetryKeys.get(sessionID) === retryKey) {
      log(`[${HOOK_NAME}] session.status retry deduped`, {
        sessionID,
        retryKey,
      })
      return
    }
    sessionStatusRetryKeys.set(sessionID, retryKey)

    if (sessionRetryInFlight.has(sessionID)) {
      if (timeoutEnabled) {
        log(`[${HOOK_NAME}] Overriding in-flight retry due to provider auto-retry signal`, {
          sessionID,
          model,
        })
        await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")
        sessionRetryInFlight.delete(sessionID)
      } else {
        log(`[${HOOK_NAME}] session.status retry skipped - retry already in flight`, { sessionID })
        return
      }
    }

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
    if (fallbackModels.length === 0) {
      if (!sessionStates.has(sessionID)) {
        sessionStatusRetryKeys.delete(sessionID)
      }
      log(`[${HOOK_NAME}] session.status retry skipped - no fallback models resolved`, {
        sessionID,
        resolvedAgent,
        eventAgent: agent,
      })
      return
    }

    let state = existingState
    if (!state) {
      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.status",
        eventModel: model,
        resolvedAgent,
        pluginConfig,
      })
      if (!initialModel) {
        sessionStatusRetryKeys.delete(sessionID)
        log(`[${HOOK_NAME}] session.status retry missing model info, cannot fallback`, { sessionID })
        return
      }

      state = createFallbackState(initialModel)
      sessionStates.set(sessionID, state)
    }

    sessionLastAccess.set(sessionID, Date.now())

    if (state.pendingFallbackModel) {
      if (state.pendingFallbackPromptMayHaveBeenAccepted) {
        log(`[${HOOK_NAME}] session.status retry skipped (pending fallback prompt may already be accepted)`, {
          sessionID,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        return
      }
      if (timeoutEnabled) {
        log(`[${HOOK_NAME}] Clearing pending fallback due to provider auto-retry signal`, {
          sessionID,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        state.pendingFallbackModel = undefined
        state.pendingFallbackPromptMayHaveBeenAccepted = false
      } else {
        log(`[${HOOK_NAME}] session.status retry skipped (pending fallback in progress)`, {
          sessionID,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        return
      }
    }

    log(`[${HOOK_NAME}] Detected provider auto-retry signal in session.status`, {
      sessionID,
      model: state.currentModel,
      retryAttempt: status.attempt,
      retryMessage,
      resolvedAgent,
      fallbackModels,
    })

    await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels,
      resolvedAgent,
      source: "session.status",
    })
  }
}

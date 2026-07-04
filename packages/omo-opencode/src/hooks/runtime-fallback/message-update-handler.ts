import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError, extractAutoRetrySignal, containsErrorContent } from "./error-classifier"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { hasVisibleAssistantResponse } from "./visible-assistant-response"
import { stringifyRuntimeFallbackModel } from "./model-input"
import { subagentSessions } from "../../features/claude-code-session-state"
import { isAbortError } from "../../shared/is-abort-error"
import { resolveMessageEventSessionID } from "../../shared/event-session-id"
import { modelIdentity } from "./model-identity"
import { hasTimeoutDrivenFallbackEnabled } from "./timeout-config"
import { normalizeModelToCanonicalString } from "./normalize-model"

export { hasVisibleAssistantResponse } from "./visible-assistant-response"

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const { ctx, config, pluginConfig, sessionStates, sessionLastAccess, sessionRetryInFlight, sessionAwaitingFallbackResult, sessionFallbackAbortInFlight, sessionStatusRetryKeys } = deps
  const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)

  return async (props: Record<string, unknown> | undefined) => {
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = resolveMessageEventSessionID(props)
    const timeoutEnabled = hasTimeoutDrivenFallbackEnabled(config)
    const eventParts = props?.parts as Array<{ type?: string; text?: string }> | undefined
    const infoParts = info?.parts as Array<{ type?: string; text?: string }> | undefined
    const parts = eventParts && eventParts.length > 0 ? eventParts : infoParts
    const retrySignalResult = extractAutoRetrySignal(info)
    const partsText = (parts ?? [])
      .filter((p) => typeof p?.text === "string")
      .map((p) => (p.text ?? "").trim())
      .filter((text) => text.length > 0)
      .join("\n")
    const retrySignalFromParts = partsText
      ? extractAutoRetrySignal({ message: partsText, status: partsText, summary: partsText })?.signal
      : undefined
    const retrySignal = retrySignalResult?.signal ?? retrySignalFromParts
    const errorContentResult = containsErrorContent(parts)
    const error = info?.error ??
      (retrySignal && timeoutEnabled ? { name: "ProviderRateLimitError", message: retrySignal } : undefined) ??
      (errorContentResult.hasError ? { name: "MessageContentError", message: errorContentResult.errorMessage || "Message contains error content" } : undefined)
    const role = info?.role as string | undefined
    const model = normalizeModelToCanonicalString(info?.model) ?? stringifyRuntimeFallbackModel(info?.model)

    if (sessionID && role === "assistant" && !error) {
      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        return
      }

      const hasVisible = await checkVisibleResponse(ctx, sessionID, info)
      if (!hasVisible) {
        const refreshed = helpers.refreshSessionFallbackTimeout(sessionID, "message.updated.progress")
        log(`[${HOOK_NAME}] Assistant update observed without visible final response; ${refreshed ? "refreshed" : "kept"} fallback timeout`, {
          sessionID,
          model,
        })
        return
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      sessionFallbackAbortInFlight.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      helpers.clearSessionFallbackState(sessionID)
      let state = sessionStates.get(sessionID)
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
        state.pendingFallbackPromptMayHaveBeenAccepted = false
      }
      log(`[${HOOK_NAME}] Assistant response observed; cleared fallback timeout`, { sessionID, model })
      return
    }

    if (sessionID && role === "assistant" && error) {
      let state = sessionStates.get(sessionID)
      const pendingFallbackModel = state?.pendingFallbackModel
      const pendingFallbackIdentity = modelIdentity(pendingFallbackModel)
      const modelIdentityValue = modelIdentity(model)
      const wasAwaitingFallbackResult = sessionAwaitingFallbackResult.has(sessionID)
      if ((sessionFallbackAbortInFlight.has(sessionID) || wasAwaitingFallbackResult) && !retrySignal && isAbortError(error)) {
        log(`[${HOOK_NAME}] message.updated matched fallback abort; preserving retry state`, { sessionID, model })
        return
      }

      if (
        wasAwaitingFallbackResult &&
        pendingFallbackModel &&
        !retrySignal &&
        (!pendingFallbackIdentity || !modelIdentityValue || modelIdentityValue !== pendingFallbackIdentity)
      ) {
        log(`[${HOOK_NAME}] message.updated fallback skipped - awaiting fallback result`, {
          sessionID,
          pendingFallbackModel,
          model,
        })
        return
      }
      if (wasAwaitingFallbackResult) {
        sessionAwaitingFallbackResult.delete(sessionID)
      }
      if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
        log(`[${HOOK_NAME}] message.updated fallback skipped (retry in flight)`, { sessionID })
        return
      }

      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        log(`[${HOOK_NAME}] Overriding active retry due to provider auto-retry signal`, {
          sessionID,
          model,
        })
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal")
        sessionRetryInFlight.delete(sessionID)
      }

      if (retrySignal && timeoutEnabled) {
        log(`[${HOOK_NAME}] Detected provider auto-retry signal`, { sessionID, model })
      }

      if (!retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
      }

      log(`[${HOOK_NAME}] message.updated with assistant error`, {
        sessionID,
        model,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error),
      })

      if (!isRetryableError(error, config.retry_on_errors)) {
        log(`[${HOOK_NAME}] message.updated error not retryable, skipping fallback`, {
          sessionID,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error),
        })
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionFallbackAbortInFlight.delete(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        helpers.clearSessionFallbackTimeout(sessionID)
        if (state) {
          state.pendingFallbackModel = undefined
          state.pendingFallbackPromptMayHaveBeenAccepted = false
        }
        return
      }

      const agent = info?.agent as string | undefined
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

      if (fallbackModels.length === 0) {
        sessionFallbackAbortInFlight.delete(sessionID)
        if (
          subagentSessions.has(sessionID) &&
          classifyErrorType(error) === "quota_exceeded"
        ) {
          log(`[${HOOK_NAME}] Aborting subagent on unrecoverable quota error (no fallback configured)`, {
            sessionID,
            model,
          })
          await helpers.abortSessionRequest(sessionID, "message.updated.subagent-quota-no-fallback")
        }
        return
      }

      if (!state) {
        const initialModel = resolveFallbackBootstrapModel({
          sessionID,
          source: "message.updated",
          eventModel: model,
          resolvedAgent,
          pluginConfig,
        })

        if (!initialModel) {
          log(`[${HOOK_NAME}] message.updated missing model info, cannot fallback`, {
            sessionID,
            errorName: extractErrorName(error),
            errorType: classifyErrorType(error),
          })
          return
        }

        state = createFallbackState(initialModel)
        sessionStates.set(sessionID, state)
        sessionLastAccess.set(sessionID, Date.now())
      } else {
        sessionLastAccess.set(sessionID, Date.now())

        if (state.pendingFallbackModel) {
          if (retrySignal && timeoutEnabled) {
            log(`[${HOOK_NAME}] Clearing pending fallback due to provider auto-retry signal`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
            })
            state.pendingFallbackModel = undefined
            state.pendingFallbackPromptMayHaveBeenAccepted = false
          } else {
            log(`[${HOOK_NAME}] message.updated fallback skipped (pending fallback in progress)`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
            })
            return
          }
        }
      }

      if (classifyErrorType(error) === "quota_exceeded") {
        await helpers.abortSessionRequest(sessionID, "message.updated.quota-fallback")
        sessionRetryInFlight.delete(sessionID)
      }

      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state,
        fallbackModels,
        resolvedAgent,
        source: "message.updated",
      })
    }
  }
}

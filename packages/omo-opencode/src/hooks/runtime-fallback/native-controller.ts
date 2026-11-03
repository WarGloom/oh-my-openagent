import { getAgentConfigKey } from "../../shared/agent-display-names"
import { isRetryableError } from "./error-classifier"
import { flattenToFallbackModelStrings, normalizeFallbackModels } from "../../shared/model-resolver"
import type { FallbackModelObject, FallbackModels } from "../../config/schema/fallback-models"
import { parseModelString } from "../../shared/model-string-parser"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { log } from "../../shared/logger"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { clearSessionPromptParams } from "../../shared/session-prompt-params-state"
import { HOOK_NAME } from "./constants"
import { getRawFallbackModels } from "./fallback-models"
import { areRuntimeModelsEquivalent, createFallbackState, prepareFallback } from "./fallback-state"
import { restoreFallbackState, snapshotFallbackState } from "./fallback-state-snapshot"
import { buildRetryModelPayload } from "./retry-model-payload"
import { resolveRuntimeModelSettings } from "./runtime-model-settings"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import type { HookDeps } from "./types"

const nativeClients = new WeakSet<object>()

export function hasNativeRuntimeFallback(client: object): boolean {
  return nativeClients.has(client)
}

type RetryModel = NonNullable<ReturnType<typeof buildRetryModelPayload>>

/** The model native fallback last applied to a session, so task records report the model that answered. */
const nativeSessionModels = new Map<string, RetryModel>()

export function getNativeFallbackModel(sessionID: string): RetryModel | undefined {
  return nativeSessionModels.get(sessionID)
}

export type NativeFallbackInput = {
  readonly sessionID: string
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly error: unknown
  /** Host model availability; a model it rejects is skipped like an unreachable V1 fallback. */
  readonly isAvailable?: (model: { providerID: string; modelID: string }) => boolean
}

function nativeModelChain(
  config: Partial<FallbackModelObject> & { fallback_models?: FallbackModels; models?: FallbackModels },
) {
  const fallbacks = normalizeFallbackModels(config.fallback_models ?? config.models)
  if (!config.model) return fallbacks
  const entries = [
    { model: config.model, reasoning: config.reasoning ?? config.variant, reasoningEffort: config.reasoningEffort },
    ...(fallbacks ?? []),
  ]
  const models = flattenToFallbackModelStrings(entries) ?? []
  return entries.filter(
    (_entry, index) => models.findIndex((model) => areRuntimeModelsEquivalent(model, models[index])) === index,
  )
}

export function createNativeFallbackController(deps: HookDeps) {
  let active = false
  const promptParamSessions = new Set<string>()
  // Native sessions can start outside OMO's model resolver; retain their untried configured primary.
  const categories = Object.fromEntries(
    Object.entries(deps.pluginConfig?.categories ?? {}).map(([key, value]) => [
      key,
      { ...value, fallback_models: nativeModelChain(value) },
    ]),
  )
  const pluginConfig = deps.pluginConfig && {
    ...deps.pluginConfig,
    agents: Object.fromEntries(
      Object.entries(deps.pluginConfig.agents ?? {}).map(([key, value]) => [
        key,
        value && {
          ...value,
          fallback_models: nativeModelChain({
            ...value,
            fallback_models:
              value.fallback_models ??
              value.models ??
              (value.category ? categories[value.category]?.fallback_models : undefined),
          }),
        },
      ]),
    ),
    categories,
  }

  return {
    get enabled() {
      return deps.config.enabled
    },
    get retryOnErrors() {
      return deps.config.retry_on_errors
    },
    get active() {
      return active
    },
    activate() {
      active = true
      nativeClients.add(deps.ctx.client)
    },
    dispose() {
      active = false
      nativeClients.delete(deps.ctx.client)
    },
    forget(sessionID: string) {
      deps.sessionStates.delete(sessionID)
      deps.sessionLastAccess.delete(sessionID)
      if (promptParamSessions.delete(sessionID)) clearSessionPromptParams(sessionID)
      nativeSessionModels.delete(sessionID)
    },
    async recover(
      input: NativeFallbackInput,
      apply: (model: RetryModel) => Promise<RetryModel | void>,
    ): Promise<boolean> {
      if (!deps.config.enabled || !isRetryableError(input.error, deps.config.retry_on_errors)) return false
      if (deps.sessionRetryInFlight.has(input.sessionID)) return false
      const agent = input.agent ? getAgentConfigKey(input.agent) : undefined
      const entries = (getRawFallbackModels(input.sessionID, agent, pluginConfig) ?? []).filter((entry) => {
        const parsed = parseModelString(typeof entry === "string" ? entry : entry.model)
        if (!parsed || !input.isAvailable) return true
        if (
          input.isAvailable({
            providerID: parsed.providerID,
            modelID: transformModelForProvider(parsed.providerID, parsed.modelID),
          })
        )
          return true
        log(`[${HOOK_NAME}] Skipping fallback model unavailable on the host`, {
          sessionID: input.sessionID,
          model: typeof entry === "string" ? entry : entry.model,
        })
        return false
      })
      const models = flattenToFallbackModelStrings(entries) ?? []
      if (models.length === 0) return false
      let state = deps.sessionStates.get(input.sessionID)
      const currentModel =
        input.model ??
        state?.currentModel ??
        resolveFallbackBootstrapModel({
          sessionID: input.sessionID,
          source: "native",
          resolvedAgent: agent,
          pluginConfig,
        }) ??
        models[0]
      if (!state || !areRuntimeModelsEquivalent(state.currentModel, currentModel)) {
        state = createFallbackState(currentModel)
        deps.sessionStates.set(input.sessionID, state)
      }
      deps.sessionLastAccess.set(input.sessionID, Date.now())
      const snapshot = snapshotFallbackState(state)
      const selected = prepareFallback(input.sessionID, state, models, deps.config)
      if (!selected.success || !selected.newModel) return false
      const entry = entries[state.fallbackIndex]
      const entrySettings = typeof entry === "object" ? entry : undefined
      const runtimeSettings = resolveRuntimeModelSettings(input.sessionID, agent, pluginConfig)
      // Entry settings win over agent/category settings, as in V1 delegated fallback (applyFallbackEntrySettings).
      const payload = buildRetryModelPayload(selected.newModel, {
        reasoning: entrySettings?.reasoning ?? runtimeSettings.reasoning,
        reasoningEffort:
          entrySettings?.reasoning === undefined && runtimeSettings.reasoning === undefined
            ? (entrySettings?.reasoningEffort ?? runtimeSettings.reasoningEffort)
            : runtimeSettings.reasoningEffort,
      })
      if (!payload) {
        restoreFallbackState(state, snapshot)
        return false
      }
      deps.sessionRetryInFlight.add(input.sessionID)
      try {
        const applied = await apply(payload)
        state.pendingFallbackModel = undefined
        nativeSessionModels.set(input.sessionID, applied ?? payload)
        const requestSettings = {
          reasoningEffort: payload.reasoningEffort,
          temperature: entrySettings?.temperature,
          top_p: entrySettings?.top_p,
          maxTokens: entrySettings?.maxTokens,
          thinking: entrySettings?.thinking,
        }
        if (Object.values(requestSettings).some((value) => value !== undefined)) {
          applySessionPromptParams(input.sessionID, {
            providerID: payload.model.providerID,
            modelID: payload.model.modelID,
            ...requestSettings,
          })
          promptParamSessions.add(input.sessionID)
        } else if (promptParamSessions.delete(input.sessionID)) {
          clearSessionPromptParams(input.sessionID)
        }
        return true
      } catch (error) {
        restoreFallbackState(state, snapshot)
        throw error
      } finally {
        deps.sessionRetryInFlight.delete(input.sessionID)
      }
    },
  }
}

export type NativeFallbackController = ReturnType<typeof createNativeFallbackController>

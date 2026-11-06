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
import {
  areRuntimeModelsEquivalent,
  createFallbackState,
  isModelInCooldown,
  prepareFallback,
  stringifyRuntimeModelWithVariant,
} from "./fallback-state"
import { restoreFallbackState, snapshotFallbackState } from "./fallback-state-snapshot"
import { buildRetryModelPayload } from "./retry-model-payload"
import { resolveRuntimeModelSettings } from "./runtime-model-settings"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import type { HookDeps } from "./types"
import { forgetNativeRecovery, nativeRecoveryState } from "../../v2/native-recovery-state"
import { showFallbackToast } from "./fallback-retry-dispatcher"
import { createNativeQuotaSignals } from "./native-quota-signals"

const nativeClients = new WeakSet<object>()
const nativeQuotaClients = new WeakMap<object, () => Promise<ReadonlySet<string>>>()

export async function getNativeUnavailableModels(client: object): Promise<ReadonlySet<string> | undefined> {
  return nativeQuotaClients.get(client)?.()
}

export function hasNativeRuntimeFallback(client: object): boolean {
  return nativeClients.has(client)
}

type RetryModel = NonNullable<ReturnType<typeof buildRetryModelPayload>>

/** The model native fallback last applied to a session, so task records report the model that answered. */
const nativeSessionModels = nativeRecoveryState.models

export function getNativeFallbackModel(sessionID: string): RetryModel | undefined {
  return nativeSessionModels.get(sessionID)
}

export type NativeFallbackInput = {
  readonly sessionID: string
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly variant?: string
  readonly error: unknown
  readonly reason?: "timeout"
  /** Host model availability; a model it rejects is skipped like an unreachable V1 fallback. */
  readonly isAvailable?: (model: { providerID: string; modelID: string }) => boolean
  readonly onExhausted?: () => void
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
  const quota = createNativeQuotaSignals()
  let currentConnections: () => Promise<ReadonlyMap<string, string>> = async () => new Map()
  const unavailable = async (): Promise<ReadonlySet<string>> => {
    const connections = await currentConnections()
    const models = new Set<string>()
    for (const [provider, key] of connections) {
      for (const model of quota.unavailable(key)) if (model.startsWith(`${provider}/`)) models.add(model)
    }
    return models
  }
  const promptParamSessions = nativeRecoveryState.promptParams
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
    get timeouts() {
      return {
        firstProgressMs: deps.config.first_progress_timeout_seconds * 1000,
        stallMs: deps.config.stall_timeout_seconds * 1000,
        hardMs: deps.config.hard_timeout_seconds * 1000,
      }
    },
    get active() {
      return active
    },
    activate() {
      active = true
      nativeClients.add(deps.ctx.client)
      nativeQuotaClients.set(deps.ctx.client, unavailable)
    },
    dispose() {
      active = false
      nativeClients.delete(deps.ctx.client)
      if (nativeQuotaClients.get(deps.ctx.client) === unavailable) nativeQuotaClients.delete(deps.ctx.client)
      quota.clear()
    },
    observeQuota: quota.observe,
    setCurrentConnections: (read: () => Promise<ReadonlyMap<string, string>>) => {
      currentConnections = read
    },
    forget(sessionID: string) {
      deps.sessionStates.delete(sessionID)
      deps.sessionLastAccess.delete(sessionID)
      if (promptParamSessions.delete(sessionID)) clearSessionPromptParams(sessionID)
      forgetNativeRecovery(sessionID)
    },
    async restorePrimary(
      input: { readonly sessionID: string; readonly agent?: string; readonly model: string; readonly variant?: string },
      apply: (model: RetryModel) => Promise<void>,
    ): Promise<void> {
      const state = nativeRecoveryState.states.get(input.sessionID)
      if (!state || nativeRecoveryState.inFlight.has(input.sessionID)) return
      const applied = nativeSessionModels.get(input.sessionID)
      if (
        !areRuntimeModelsEquivalent(state.currentModel, input.model) ||
        (applied && applied.variant !== input.variant)
      ) {
        nativeRecoveryState.states.set(
          input.sessionID,
          createFallbackState(stringifyRuntimeModelWithVariant(input.model, input.variant)),
        )
        nativeSessionModels.delete(input.sessionID)
        if (promptParamSessions.delete(input.sessionID)) clearSessionPromptParams(input.sessionID)
        return
      }
      if (
        !deps.config.restore_primary_after_cooldown ||
        areRuntimeModelsEquivalent(state.currentModel, state.originalModel) ||
        state.pendingFallbackModel ||
        isModelInCooldown(state.originalModel, state, deps.config.cooldown_seconds)
      )
        return
      const settings = resolveRuntimeModelSettings(
        input.sessionID,
        input.agent ? getAgentConfigKey(input.agent) : undefined,
        pluginConfig,
      )
      const payload = buildRetryModelPayload(state.originalModel, settings)
      if (!payload) return
      const blocked = await unavailable()
      if (
        nativeRecoveryState.inFlight.has(input.sessionID) ||
        nativeRecoveryState.states.get(input.sessionID) !== state ||
        blocked.has(`${payload.model.providerID}/${payload.model.modelID}`)
      )
        return
      nativeRecoveryState.inFlight.add(input.sessionID)
      try {
        await apply(payload)
        const restored = createFallbackState(state.originalModel)
        nativeRecoveryState.states.set(input.sessionID, restored)
        deps.sessionStates.set(input.sessionID, restored)
        nativeSessionModels.set(input.sessionID, payload)
        if (promptParamSessions.delete(input.sessionID)) clearSessionPromptParams(input.sessionID)
      } finally {
        nativeRecoveryState.inFlight.delete(input.sessionID)
      }
    },
    async recover(
      input: NativeFallbackInput,
      apply: (model: RetryModel) => Promise<RetryModel | "declined" | "duplicate" | void>,
    ): Promise<boolean> {
      if (
        !deps.config.enabled ||
        (input.reason !== "timeout" && !isRetryableError(input.error, deps.config.retry_on_errors))
      )
        return false
      const blocked = await unavailable()
      if (deps.sessionRetryInFlight.has(input.sessionID) || nativeRecoveryState.inFlight.has(input.sessionID))
        return false
      const agent = input.agent ? getAgentConfigKey(input.agent) : undefined
      const allEntries = getRawFallbackModels(input.sessionID, agent, pluginConfig) ?? []
      const entries = allEntries.filter((entry) => {
        const parsed = parseModelString(typeof entry === "string" ? entry : entry.model)
        if (!parsed) return true
        const modelID = transformModelForProvider(parsed.providerID, parsed.modelID)
        if (blocked.has(`${parsed.providerID}/${modelID}`)) return false
        if (!input.isAvailable || input.isAvailable({ providerID: parsed.providerID, modelID })) return true
        log(`[${HOOK_NAME}] Skipping fallback model unavailable on the host`, {
          sessionID: input.sessionID,
          model: typeof entry === "string" ? entry : entry.model,
        })
        return false
      })
      const models = flattenToFallbackModelStrings(entries) ?? []
      if (models.length === 0) {
        input.onExhausted?.()
        return false
      }
      let state = nativeRecoveryState.states.get(input.sessionID) ?? deps.sessionStates.get(input.sessionID)
      const currentModel =
        stringifyRuntimeModelWithVariant(input.model, input.variant) ??
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
      nativeRecoveryState.states.set(input.sessionID, state)
      deps.sessionLastAccess.set(input.sessionID, Date.now())
      const snapshot = snapshotFallbackState(state)
      if (state.fallbackIndex >= 0) {
        const currentIndex = allEntries.findIndex((entry) =>
          areRuntimeModelsEquivalent(typeof entry === "string" ? entry : entry.model, state.currentModel),
        )
        if (currentIndex >= 0)
          state.fallbackIndex =
            allEntries.slice(0, currentIndex + 1).filter((entry) => entries.includes(entry)).length - 1
      }
      const selected = prepareFallback(input.sessionID, state, models, deps.config)
      if (!selected.success || !selected.newModel) {
        restoreFallbackState(state, snapshot)
        input.onExhausted?.()
        return false
      }
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
      nativeRecoveryState.inFlight.add(input.sessionID)
      try {
        const applied = await apply(payload)
        // Only a new host admission spends a fallback attempt or emits a toast.
        if (applied === "declined" || applied === "duplicate") {
          restoreFallbackState(state, snapshot)
          return applied === "duplicate"
        }
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
        await showFallbackToast(
          deps,
          input.sessionID,
          `Switched to ${selected.newModel.split("/").pop()} for next request`,
        )
        return true
      } catch (error) {
        restoreFallbackState(state, snapshot)
        throw error
      } finally {
        deps.sessionRetryInFlight.delete(input.sessionID)
        nativeRecoveryState.inFlight.delete(input.sessionID)
      }
    },
  }
}

export type NativeFallbackController = ReturnType<typeof createNativeFallbackController>

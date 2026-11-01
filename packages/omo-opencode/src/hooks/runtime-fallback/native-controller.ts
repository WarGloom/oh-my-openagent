import { getAgentConfigKey } from "../../shared/agent-display-names"
import { isRetryableError } from "./error-classifier"
import { getFallbackModelsForSession } from "./fallback-models"
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

export type NativeFallbackInput = {
  readonly sessionID: string
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly error: unknown
}

type RetryModel = NonNullable<ReturnType<typeof buildRetryModelPayload>>

export function createNativeFallbackController(deps: HookDeps) {
  let active = false
  // The native adapter accepts unified category `models` without changing V1's legacy resolution.
  const pluginConfig = deps.pluginConfig && {
    ...deps.pluginConfig,
    categories: Object.fromEntries(
      Object.entries(deps.pluginConfig.categories ?? {}).map(([key, value]) => [
        key,
        { ...value, fallback_models: value.fallback_models ?? value.models },
      ]),
    ),
  }

  return {
    get enabled() {
      return deps.config.enabled
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
    },
    async recover(input: NativeFallbackInput, apply: (model: RetryModel) => Promise<void>): Promise<boolean> {
      if (!deps.config.enabled || !isRetryableError(input.error, deps.config.retry_on_errors)) return false
      if (deps.sessionRetryInFlight.has(input.sessionID)) return false
      const agent = input.agent ? getAgentConfigKey(input.agent) : undefined
      const models = getFallbackModelsForSession(input.sessionID, agent, pluginConfig)
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
      const payload = buildRetryModelPayload(
        selected.newModel,
        resolveRuntimeModelSettings(input.sessionID, agent, pluginConfig),
      )
      if (!payload) {
        restoreFallbackState(state, snapshot)
        return false
      }
      deps.sessionRetryInFlight.add(input.sessionID)
      try {
        await apply(payload)
        state.pendingFallbackModel = undefined
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

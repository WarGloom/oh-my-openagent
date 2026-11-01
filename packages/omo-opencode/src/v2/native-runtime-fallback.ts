import type { Hooks } from "@opencode-ai/plugin"
import type { RuntimeFallbackHook } from "../hooks/runtime-fallback/types"
import type { NativeFallbackController } from "../hooks/runtime-fallback/native-controller"
import { classifyErrorType, extractErrorName, isRetryableError } from "../hooks/runtime-fallback/error-classifier"
import { SessionCategoryRegistry } from "../shared/session-category-registry"
import { filterProvidersServingModel } from "../features/background-agent/fallback-provider-model-filter"
import { log } from "../shared/logger"
import type { V2Event, V2ModelRef, V2PluginContext, V2StructuredError } from "./context-types"

const controllers = new WeakMap<Hooks, NativeFallbackController>()

export function bindNativeRuntimeFallback(hooks: Hooks, runtime: RuntimeFallbackHook | null): void {
  if (runtime?.native?.enabled) controllers.set(hooks, runtime.native)
}

function classifierError(error: V2StructuredError) {
  const names: Readonly<Record<string, string>> = {
    "provider.auth": "AI_LoadAPIKeyError",
    "provider.no-route": "ProviderModelNotFoundError",
    "provider.content-filter": "ContentFilterError",
    "provider.quota": "QuotaExceededError",
    "provider.chatgpt-limit": "UsageLimitError",
  }
  return { name: names[error.type] ?? error.type, data: { message: error.message, statusCode: error.status, responseBody: error.response?.body } }
}

type RetryPayload = Parameters<Parameters<NativeFallbackController["recover"]>[1]>[0]

/**
 * The host model list decides availability (V1's connected-provider rule) and which variants a model
 * accepts. An empty list means unknown, so nothing is skipped and the variant is kept.
 */
async function hostModels(context: V2PluginContext) {
  const models = (await context.model.list()).data
  const modelsByProvider: Record<string, string[]> = {}
  for (const model of models) if (model.enabled) (modelsByProvider[model.providerID] ??= []).push(model.modelID)
  const connectedSet = new Set(Object.keys(modelsByProvider).map((provider) => provider.toLowerCase()))
  const isAvailable = models.length === 0 ? undefined : ({ providerID, modelID }: { providerID: string; modelID: string }) => connectedSet.has(providerID.toLowerCase())
    && filterProvidersServingModel({ providers: [providerID], model: modelID, connectedSet, modelsByProvider, transformModelForProvider: (_provider, model) => model }).length > 0
  const modelRef = (sessionID: string, payload: RetryPayload): V2ModelRef => {
    const { providerID, modelID } = payload.model
    const hostModel = models.find((model) => model.providerID === providerID && model.modelID === modelID)
    if (payload.variant === undefined || !hostModel || hostModel.variants.some((variant) => variant.id === payload.variant)) {
      return { providerID, id: modelID, variant: payload.variant }
    }
    log("[runtime-fallback] Dropping variant the host model does not offer", { sessionID, model: `${providerID}/${modelID}`, variant: payload.variant })
    return { providerID, id: modelID, variant: undefined }
  }
  return { isAvailable, modelRef }
}

export async function installNativeRuntimeFallback(context: V2PluginContext, hooks: Hooks) {
  const controller = controllers.get(hooks)
  if (!controller) return undefined
  const recoveredFailures = new Map<string, string>()
  const recover = async (
    input: { sessionID: string; agent: string | undefined; model: string | undefined; error: V2StructuredError; attempt?: number },
    apply: (model: V2ModelRef) => Promise<void>,
  ): Promise<boolean> => {
    const error = classifierError(input.error)
    const errorType = classifyErrorType(error)
    const retryable = isRetryableError(error, controller.retryOnErrors)
    const details = {
      sessionID: input.sessionID,
      source: input.attempt === undefined ? "terminal" : "retry",
      attempt: input.attempt,
      model: input.model,
      error: { type: input.error.type, name: extractErrorName(error), classification: errorType, status: input.error.status, message: input.error.message.slice(0, 300) },
    }
    if (!retryable) {
      log("[runtime-fallback] Native recovery decision", { ...details, outcome: "declined as not retryable" })
      return false
    }
    // V1 session-status-handler.ts:142-159 gives non-quota errors one provider retry.
    const immediate = errorType === "quota_exceeded" || errorType === "model_not_found"
    if (input.attempt !== undefined && input.attempt <= 1 && !immediate) {
      log("[runtime-fallback] Native recovery decision", { ...details, outcome: "left to V2's same-model retry" })
      return false
    }
    const host = await hostModels(context)
    const recovered = await controller.recover({ ...input, error, isAvailable: host.isAvailable }, async (payload) => {
      const model = host.modelRef(input.sessionID, payload)
      log("[runtime-fallback] Native recovery decision", { ...details, outcome: `fallback to ${model.providerID}/${model.id}` })
      await apply(model)
      return { ...payload, variant: model.variant }
    })
    if (!recovered) log("[runtime-fallback] Native recovery decision", { ...details, outcome: "declined because no chain models remain" })
    return recovered
  }
  const registration = await context.session.hook("retry", async (event) => {
    const recovered = await recover({
      sessionID: event.sessionID,
      agent: event.agent,
      model: `${event.model.providerID}/${event.model.id}`,
      error: event.error,
      attempt: event.attempt,
    }, async (model) => {
      await context.session.switchModel({ sessionID: event.sessionID, model })
    })
    if (recovered) event.decision = { retry: true, delay: 0 }
  })
  controller.activate()

  return {
    async beforeEvent(event: V2Event): Promise<boolean> {
      const data = event.data
      if (typeof data !== "object" || data === null || !("sessionID" in data) || typeof data.sessionID !== "string") return false
      const sessionID = data.sessionID
      if (event.type === "session.deleted") {
        controller.forget(sessionID)
        recoveredFailures.delete(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        return false
      }
      if (event.type !== "session.execution.failed" || !("error" in data)) return false
      const error = data.error
      if (typeof error !== "object" || error === null || !("type" in error) || typeof error.type !== "string" || !("message" in error) || typeof error.message !== "string") return false
      const failure = { type: error.type, message: error.message, status: "status" in error && typeof error.status === "number" ? error.status : undefined }
      const history = await context.session.context({ sessionID })
      const last = history.at(-1)
      if (last && last.type !== "idle") return true
      const failureID = last?.id ?? JSON.stringify(data)
      if (recoveredFailures.get(sessionID) === failureID) return true
      const session = await context.session.get({ sessionID })
      return recover({ sessionID, agent: session.agent, model: session.model && `${session.model.providerID}/${session.model.id}`, error: failure }, async (model) => {
        await context.session.switchModel({ sessionID, model })
        // No explicit id: the host assigns an ascending id, so turn-order readers see the continuation after the failure.
        await context.session.synthetic({ sessionID, text: "Continue the existing task after the model failure. Preserve completed work.", delivery: "steer", resume: true })
        recoveredFailures.set(sessionID, failureID)
      })
    },
    async dispose() {
      controller.dispose()
      recoveredFailures.clear()
      await registration.dispose()
    },
  }
}

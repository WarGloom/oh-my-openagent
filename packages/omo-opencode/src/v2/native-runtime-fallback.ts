import { createHash } from "node:crypto"
import type { Hooks } from "@opencode-ai/plugin"
import type { RuntimeFallbackHook } from "../hooks/runtime-fallback/types"
import type { NativeFallbackController } from "../hooks/runtime-fallback/native-controller"
import { classifyErrorType, extractErrorName, isRetryableError } from "../hooks/runtime-fallback/error-classifier"
import { SessionCategoryRegistry } from "../shared/session-category-registry"
import { filterProvidersServingModel } from "../features/background-agent/fallback-provider-model-filter"
import { log } from "../shared/logger"
import type { V2Event, V2ModelRef, V2PluginContext, V2StructuredError } from "./context-types"
import { createNativeProgressWatchdog } from "./native-progress-watchdog"
import { recoverNativeFailure } from "./native-recovery-state"

const controllers = new WeakMap<Hooks, NativeFallbackController>()

// Stable per failure, so a replayed or concurrent admission of the same failure is a host duplicate.
function recoveryMessageID(failureID: string): string {
  return `msg_${createHash("sha256").update(`omo-native-recovery:${failureID}`).digest("hex").slice(0, 26)}`
}

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
  let disposed = false
  const watchdog = createNativeProgressWatchdog({
    context, timeouts: controller.timeouts,
    warn: (error) => log("[runtime-fallback] Native watchdog failed", { error: error instanceof Error ? error.message : String(error) }),
    recover: async (sessionID, request, ownership) => {
      const watermark = (await context.session.context({ sessionID })).at(-1)?.id
      const host = await hostModels(context)
      if (!ownership.current()) return false
      return controller.recover({ sessionID, agent: request.agent, model: `${request.model.providerID}/${request.model.id}`, variant: request.model.variant === "default" ? undefined : request.model.variant, reason: "timeout", error: { name: "RequestTimeoutError", data: { message: "Native request made no progress before its configured deadline" } }, isAvailable: host.isAvailable }, async (payload) => {
        const model = host.modelRef(sessionID, payload)
        const newest = (await context.session.context({ sessionID })).at(-1)?.id
        if (!ownership.current() || newest !== watermark) return "declined"
        let duplicate = true
        const committed = await context.experimental.session.recover({ sessionID }, ({ boundaryID }) => recoverNativeFailure(sessionID, boundaryID, async () => {
          if (!ownership.current()) return false
          // Only a selected candidate may interrupt; admission still requires that exact captured boundary.
          const outcome = await context.experimental.session.continueAfterFailure({
            sessionID, boundaryID, id: recoveryMessageID(boundaryID), model,
            text: "Continue the existing task after the model timeout. Preserve completed work.",
          })
          switch (outcome) {
            case "stale": return false
            case "duplicate": return true
            case "admitted": duplicate = false; return true
            default: return outcome satisfies never
          }
        }), { signal: ownership.signal })
        if (!committed) return "declined"
        return duplicate ? "duplicate" : { ...payload, variant: model.variant }
      })
    },
  })
  const watchdogRegistration = await context.session.hook("model.request", (event) => {
    if (event.kind === "primary") watchdog.start(event.sessionID, event.agent, event.model)
  })
  const promptRegistration = await context.session.hook("prompt", async (event) => {
    if (disposed) return
    const session = await context.session.get({ sessionID: event.sessionID })
    if (session.location.directory !== context.location.directory || !session.model) return
    const host = await hostModels(context)
    await controller.restorePrimary({ sessionID: event.sessionID, agent: session.agent, model: `${session.model.providerID}/${session.model.id}`, variant: session.model.variant === "default" ? undefined : session.model.variant }, async (payload) => {
      if (!disposed) await context.session.switchModel({ sessionID: event.sessionID, model: host.modelRef(event.sessionID, payload) })
    })
  })
  const recover = async (
    input: { sessionID: string; agent: string | undefined; model: string | undefined; variant?: string; error: V2StructuredError; attempt?: number; readonly onExhausted?: () => void },
    apply: (model: V2ModelRef) => Promise<void | "declined" | "duplicate">,
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
    // V2 increments attempt before the retry hook, so its first event has attempt 2.
    const immediate = errorType === "quota_exceeded" || errorType === "model_not_found"
    if (input.attempt !== undefined && input.attempt <= 2 && !immediate) {
      log("[runtime-fallback] Native recovery decision", { ...details, outcome: "left to V2's same-model retry" })
      return false
    }
    const host = await hostModels(context)
    if (disposed) return false
    let superseded = false
    const recovered = await controller.recover({ ...input, variant: input.variant === "default" ? undefined : input.variant, error, isAvailable: host.isAvailable }, async (payload) => {
      const model = host.modelRef(input.sessionID, payload)
      log("[runtime-fallback] Native recovery decision", { ...details, outcome: `fallback to ${model.providerID}/${model.id}` })
      const outcome = await apply(model)
      if (outcome === "declined") {
        superseded = true
        return "declined"
      }
      if (outcome === "duplicate") return "duplicate"
      return { ...payload, variant: model.variant }
    })
    if (!recovered) log("[runtime-fallback] Native recovery decision", { ...details, outcome: superseded ? "declined because the failed boundary moved" : "declined because no chain models remain" })
    return recovered
  }
  const registration = await context.session.hook("retry", async (event) => {
    let exhausted = false
    const recovered = await recover({
      sessionID: event.sessionID,
      agent: event.agent,
      model: `${event.model.providerID}/${event.model.id}`,
      variant: event.model.variant,
      error: event.error,
      attempt: event.attempt,
      onExhausted: () => { exhausted = true },
    }, async (model) => {
      await context.session.switchModel({ sessionID: event.sessionID, model })
    })
    if (recovered) event.decision = { retry: true, delay: 0 }
    else if (exhausted && !disposed && classifyErrorType(classifierError(event.error)) === "quota_exceeded") event.decision = { retry: false }
  })
  controller.activate()

  return {
    async beforeEvent(event: V2Event): Promise<boolean> {
      if (disposed) return true
      const watchdogDecision = watchdog.observe(event)
      if (watchdogDecision !== undefined) return watchdogDecision
      const data = event.data
      if (typeof data !== "object" || data === null || !("sessionID" in data) || typeof data.sessionID !== "string") return false
      const sessionID = data.sessionID
      if (event.type === "session.deleted") {
        controller.forget(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        return false
      }
      if (event.type !== "session.execution.failed" || !("error" in data)) return false
      const error = data.error
      if (typeof error !== "object" || error === null || !("type" in error) || typeof error.type !== "string" || !("message" in error) || typeof error.message !== "string") return false
      const failure = { type: error.type, message: error.message, status: "status" in error && typeof error.status === "number" ? error.status : undefined }
      const session = await context.session.get({ sessionID })
      if (session.location.directory !== context.location.directory || disposed) return true
      const history = await context.session.context({ sessionID })
      const last = history.at(-1)
      if (!last || last.type !== "idle" || last.outcome !== "failed") return true
      const failureID = last.id
      let superseded = false
      const handled = await recoverNativeFailure(sessionID, failureID, async () => {
        if (disposed) return false
        const currentHistory = await context.session.context({ sessionID })
        if (disposed) return false
        const current = currentHistory.at(-1)
        if (!current || current.id !== failureID || current.type !== "idle" || current.outcome !== "failed") {
          superseded = true
          return false
        }
        const currentSession = await context.session.get({ sessionID })
        if (disposed) return false
        const recovered = await recover({ sessionID, agent: currentSession.agent, model: currentSession.model && `${currentSession.model.providerID}/${currentSession.model.id}`, variant: currentSession.model?.variant, error: failure }, async (model) => {
          if (disposed) return "declined"
          // One host admission switches the model and resumes only while this failure is still the newest entry.
          const outcome = await context.experimental.session.continueAfterFailure({
            sessionID, boundaryID: failureID, id: recoveryMessageID(failureID), model,
            text: "Continue the existing task after the model failure. Preserve completed work.",
          })
          switch (outcome) {
            case "stale":
              superseded = true
              return "declined"
            case "duplicate": return "duplicate"
            case "admitted": return
            default: return outcome satisfies never
          }
        })
        return recovered
      })
      return handled || superseded
    },
    async dispose() {
      disposed = true
      watchdog.dispose()
      await watchdogRegistration.dispose()
      await promptRegistration.dispose()
      controller.dispose()
      await registration.dispose()
    },
  }
}

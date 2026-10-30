import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"
import { hasMoreFallbacks } from "../../shared/model-error-classifier"
import { extractRetryAttempt, normalizeRetryStatusMessage } from "../../shared/retry-status-utils"
import type { BackgroundTask } from "./types"

const PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK = 1
const MAX_PROVIDER_AUTO_RETRY_DEFERRAL_MS = 30_000

type ProviderAutoRetryObservation = {
  readonly key: string
  readonly firstSeenAt: number
}

const providerAutoRetryObservations = new WeakMap<BackgroundTask, ProviderAutoRetryObservation>()

export function clearProviderAutoRetryDeferral(task: BackgroundTask): void {
  providerAutoRetryObservations.delete(task)
}

export type RetryStatusInfo = {
  readonly attempt?: unknown
  readonly message?: string
  readonly next?: unknown
}

export type ProviderAutoRetryDeferral = {
  readonly retryAttempt: string
  readonly providerRetryAttemptsBeforeFallback: number
}

export function getProviderAutoRetryDeferral(
  task: BackgroundTask,
  status: RetryStatusInfo,
  now = Date.now(),
): ProviderAutoRetryDeferral | undefined {
  // Without a viable fallback the host's own bounded auto-retry is the only recovery left, so a transient
  // failure (e.g. a proxy 503) must not end the task on its first retry status. The host emits
  // session.error once its retries run out, which ends the task through the normal error path.
  const hasViableFallback = !!task.fallbackChain && hasMoreFallbacks(task.fallbackChain, task.attemptCount ?? 0)

  const retryMessage = status.message ?? ""
  if (isProviderExhaustionFallbackEligible({ name: "SessionRetry", message: retryMessage })) {
    clearProviderAutoRetryDeferral(task)
    return undefined
  }

  const retryAttempt = extractRetryAttempt(status.attempt, retryMessage)
  const parsedRetryAttempt = Number.parseInt(retryAttempt, 10)
  if (
    !Number.isFinite(parsedRetryAttempt)
    || (hasViableFallback && parsedRetryAttempt > PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK)
  ) {
    clearProviderAutoRetryDeferral(task)
    return undefined
  }

  if (status.next !== undefined) {
    if (typeof status.next !== "number" || !Number.isFinite(status.next)) {
      clearProviderAutoRetryDeferral(task)
      return undefined
    }

    const delayMs = status.next - now
    if (delayMs <= 0 || delayMs > MAX_PROVIDER_AUTO_RETRY_DEFERRAL_MS) {
      clearProviderAutoRetryDeferral(task)
      return undefined
    }
  }

  const observationKey = [
    task.currentAttemptID ?? "<no-attempt>",
    task.attemptCount ?? 0,
    retryAttempt,
    normalizeRetryStatusMessage(retryMessage),
  ].join(":")
  const observation = providerAutoRetryObservations.get(task)
  if (!observation || observation.key !== observationKey) {
    providerAutoRetryObservations.set(task, { key: observationKey, firstSeenAt: now })
  } else if (now - observation.firstSeenAt >= MAX_PROVIDER_AUTO_RETRY_DEFERRAL_MS) {
    return undefined
  }

  return {
    retryAttempt,
    providerRetryAttemptsBeforeFallback: PROVIDER_AUTO_RETRY_ATTEMPTS_BEFORE_FALLBACK,
  }
}

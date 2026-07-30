import type { BackgroundTask, LaunchInput } from "./types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { ConcurrencyManager } from "./concurrency"
import type { QueueItem } from "./constants"
import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"
import { log, readConnectedProvidersCache, readProviderModelsCache } from "../../shared"
import {
  shouldRetryError,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProvider,
} from "../../shared/model-error-classifier"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { abortWithTimeout, type AbortSessionClient } from "./abort-with-timeout"
import { ensureCurrentAttempt, scheduleRetryAttempt } from "./attempt-lifecycle"
import { sanitizeParentVisibleError } from "./parent-visible-error-sanitizer"

type FallbackRetryClient = {
  readonly session: AbortSessionClient["session"] & {
    update?: (input: {
      readonly path: { readonly id: string }
      readonly body: { readonly title: string }
      readonly query?: { readonly directory: string }
    }) => Promise<unknown>
  }
}

export class TeamModeFallbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeamModeFallbackError"
  }
}

function canonicalizeModelID(modelID: string): string {
  return modelID.toLowerCase().replace(/\./g, "-")
}

const SESSION_TITLE_MAX_LENGTH = 160
const REMINDER_DATA_MAX_LENGTH = 500
const SESSION_TITLE_UPDATE_TIMEOUT_MS = 2_000

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function normalizeHumanText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/<\/?system-reminder>/gi, "system reminder")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return truncateText(normalized, maxLength)
}

function unrefTimerHandle(handle: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (handle as ReturnType<typeof setTimeout> & { unref?: () => unknown }).unref
  if (typeof maybeUnref === "function") {
    try {
      maybeUnref.call(handle)
    } catch {
      // Best-effort timer cleanup should not affect retry recovery.
    }
  }
}

export function formatRetrySessionTitle(description: string, suffix: string): string {
  const descriptionText = normalizeHumanText(description, 100) || "Background task"
  return normalizeHumanText(`${descriptionText} ${suffix}`, SESSION_TITLE_MAX_LENGTH)
}

export function formatInternalReminderData(value: string | undefined, maxLength = REMINDER_DATA_MAX_LENGTH): string {
  const normalized = normalizeHumanText(sanitizeParentVisibleError(value ?? ""), maxLength)
  return JSON.stringify(normalized).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
}

export async function updateSessionTitleBestEffort(args: {
  client: FallbackRetryClient
  sessionID: string
  title: string
  directory?: string
  logFn?: typeof log
  logMessage: string
  logContext: Record<string, unknown>
  timeoutMs?: number
}): Promise<void> {
  if (typeof args.client.session.update !== "function") {
    return
  }

  const logFn = args.logFn ?? log
  const timeoutMs = args.timeoutMs ?? SESSION_TITLE_UPDATE_TIMEOUT_MS
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const updatePromise = args.client.session.update({
    path: { id: args.sessionID },
    body: { title: args.title },
    ...(args.directory ? { query: { directory: args.directory } } : {}),
  }).then(
    () => "updated" as const,
    (error) => {
      logFn(args.logMessage, { ...args.logContext, error })
      return "failed" as const
    },
  )
  const timeoutPromise = new Promise<"timed_out">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timed_out"), timeoutMs)
    unrefTimerHandle(timeoutHandle)
  })

  try {
    const result = await Promise.race([updatePromise, timeoutPromise])
    if (result === "timed_out") {
      logFn(args.logMessage, { ...args.logContext, timeoutMs, timedOut: true })
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

export type FallbackRetryHandlerDeps = {
  log: typeof log
  readProviderModelsCache: typeof readProviderModelsCache
  readConnectedProvidersCache: typeof readConnectedProvidersCache
  shouldRetryError: typeof shouldRetryError
  getNextFallback: typeof getNextFallback
  hasMoreFallbacks: typeof hasMoreFallbacks
  selectFallbackProvider: typeof selectFallbackProvider
  transformModelForProvider: typeof transformModelForProvider
  isProviderExhaustionFallbackEligible: (error: unknown) => boolean
}

const defaultFallbackRetryHandlerDeps: FallbackRetryHandlerDeps = {
  log,
  readProviderModelsCache,
  readConnectedProvidersCache,
  shouldRetryError,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProvider,
  transformModelForProvider,
  isProviderExhaustionFallbackEligible,
}

const fallbackRetryInFlight = new WeakMap<BackgroundTask, { token: string; promise: Promise<boolean> }>()

export async function tryFallbackRetry(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string; statusCode?: number }
  source: string
  concurrencyManager: ConcurrencyManager
  client: FallbackRetryClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
  directory?: string
  titleUpdateTimeoutMs?: number
  onRetrying?: (details: {
    task: BackgroundTask
    source: string
    previousSessionID?: string
    failedModel?: string
    failedError?: string
    nextModel: string
  }) => void
  onSameSessionRetry?: (details: {
    task: BackgroundTask
    sessionID: string
    source: string
    failedModel?: string
    failedError?: string
    nextModel: NonNullable<BackgroundTask["model"]>
  }) => Promise<boolean>
  deps?: Partial<FallbackRetryHandlerDeps>
}): Promise<boolean> {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, queuesByKey, processKey, onRetrying } = args
  const deps = { ...defaultFallbackRetryHandlerDeps, ...args.deps }
  const fallbackChain = task.fallbackChain
  const canUseProviderExhaustionFallback = deps.isProviderExhaustionFallbackEligible(errorInfo)
  const canRetry =
    (deps.shouldRetryError(errorInfo) || canUseProviderExhaustionFallback) &&
    fallbackChain &&
    fallbackChain.length > 0 &&
    deps.hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canRetry) return false

  const attemptCount = task.attemptCount ?? 0
  const providerModelsCache = deps.readProviderModelsCache()
  const connectedProviders = providerModelsCache?.connected ?? deps.readConnectedProvidersCache()
  const connectedSet = connectedProviders ? new Set(connectedProviders.map(p => p.toLowerCase())) : null

  const isReachable = (entry: FallbackEntry): boolean => {
    if (!connectedSet) return true
    return entry.providers.some((provider) => connectedSet.has(provider.toLowerCase()))
  }

  let selectedAttemptCount = attemptCount
  let nextFallback: FallbackEntry | undefined
  let nextProviderID: string | undefined
  while (fallbackChain && selectedAttemptCount < fallbackChain.length) {
    const candidate = deps.getNextFallback(fallbackChain, selectedAttemptCount)
    if (!candidate) break
    selectedAttemptCount++
    if (!isReachable(candidate)) {
      deps.log("[background-agent] Skipping unreachable fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    const candidateProviderID = deps.selectFallbackProvider(
      candidate.providers,
      task.model?.providerID,
    )
    const candidateModelID = deps.transformModelForProvider(candidateProviderID, candidate.model)
    const isNoOpFallback =
      !!task.model &&
      candidateProviderID.toLowerCase() === task.model.providerID.toLowerCase() &&
      canonicalizeModelID(candidateModelID) === canonicalizeModelID(task.model.modelID)
    if (isNoOpFallback) {
      deps.log("[background-agent] Skipping no-op fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    nextFallback = candidate
    nextProviderID = candidateProviderID
    break
  }
  if (!nextFallback) return false

  const providerID = nextProviderID ?? deps.selectFallbackProvider(
    nextFallback.providers,
    task.model?.providerID,
  )

  deps.log("[background-agent] Retryable error, attempting fallback:", {
    taskId: task.id,
    source,
    errorName: errorInfo.name,
    errorMessage: errorInfo.message?.slice(0, 100),
    attemptCount: selectedAttemptCount,
    nextModel: `${providerID}/${nextFallback.model}`,
  })

  const previousSessionID = task.sessionId
  const previousModel = task.model

  const transformedModelId = deps.transformModelForProvider(providerID, nextFallback.model)
  const nextModel = {
    providerID,
    modelID: transformedModelId,
    variant: nextFallback.variant,
    reasoning: nextFallback.reasoning,
    reasoningEffort: nextFallback.reasoningEffort,
    temperature: nextFallback.temperature,
    top_p: nextFallback.top_p,
    maxTokens: nextFallback.maxTokens,
    thinking: nextFallback.thinking,
  }

  // Guard: a team-mode task (teamRunId set) MUST carry an onSessionCreated callback so
  // the fallback session gets registered in the team-session registry under the original
  // member slot. Without it the new session would not appear as a team participant and
  // every subsequent team tool call would throw "not in team". Fail with a bounded
  // structured error instead of silently entering that confusing runtime state.
  if (task.teamRunId && !task.onSessionCreated) {
    deps.log("[background-agent] team-mode fallback denied: task has teamRunId but no onSessionCreated; cannot preserve team membership", {
      taskId: task.id,
      teamRunId: task.teamRunId,
    })
    throw new TeamModeFallbackError(
      `team-mode fallback denied: cannot preserve team context for task ${task.id} (teamRunId=${task.teamRunId})`,
    )
  }

  const retryToken = `${previousSessionID ?? "<no-session>"}:${task.currentAttemptID ?? "<no-attempt>"}:${attemptCount}`
  if (task.failedFallbackRetryToken === retryToken) {
    deps.log("[background-agent] Fallback retry skipped because this prompt already failed:", {
      taskId: task.id,
      previousSessionID,
      nextModel: `${providerID}/${transformedModelId}`,
    })
    return false
  }

  const inFlight = fallbackRetryInFlight.get(task)
  if (inFlight?.token === retryToken) {
    deps.log("[background-agent] Reusing in-flight fallback retry:", {
      taskId: task.id,
      previousSessionID,
      nextModel: `${providerID}/${transformedModelId}`,
    })
    return inFlight.promise
  }

  const retryPromise = Promise.resolve().then(async (): Promise<boolean> => {
    const nextConcurrencyKey = `${nextModel.providerID}/${nextModel.modelID}`
    const previousConcurrencyKey = task.concurrencyKey
    const shouldAcquireNextSlot =
      previousSessionID !== undefined &&
      args.onSameSessionRetry !== undefined &&
      previousConcurrencyKey !== nextConcurrencyKey

    if (previousSessionID && args.onSameSessionRetry) {
      if (task.sessionId !== previousSessionID || task.attemptCount !== attemptCount) {
        deps.log("[background-agent] Same-session fallback skipped because task advanced before retry:", {
          taskId: task.id,
          previousSessionID,
          currentSessionID: task.sessionId,
          capturedAttemptCount: attemptCount,
          currentAttemptCount: task.attemptCount,
        })
        return false
      }

      if (shouldAcquireNextSlot) {
        await concurrencyManager.acquire(nextConcurrencyKey)
      }
    }

    if (previousSessionID) {
      const aborted = await abortWithTimeout(client, previousSessionID).catch((error) => {
        deps.log("[background-agent] Failed to abort retrying session:", {
          taskId: task.id,
          previousSessionID,
          error,
        })
        return false
      })

      if (!aborted) {
        if (shouldAcquireNextSlot) {
          concurrencyManager.release(nextConcurrencyKey)
        }
        deps.log("[background-agent] Fallback retry skipped because previous session abort failed:", {
          taskId: task.id,
          previousSessionID,
          nextModel: `${providerID}/${transformedModelId}`,
        })
        return false
      }
    }

    if (task.sessionId !== previousSessionID || task.attemptCount !== attemptCount) {
      if (shouldAcquireNextSlot) {
        concurrencyManager.release(nextConcurrencyKey)
      }
      deps.log("[background-agent] Fallback retry skipped because task advanced during abort:", {
        taskId: task.id,
        previousSessionID,
        currentSessionID: task.sessionId,
        capturedAttemptCount: attemptCount,
        currentAttemptCount: task.attemptCount,
      })
      return false
    }

    if (previousSessionID && args.onSameSessionRetry) {
      try {
        await task.onSessionCreated?.(previousSessionID, nextModel)
      } catch (callbackError) {
        deps.log("[background-agent] Same-session fallback session callback failed:", {
          taskId: task.id,
          previousSessionID,
          nextModel: `${providerID}/${transformedModelId}`,
          error: callbackError,
        })
        if (shouldAcquireNextSlot) {
          concurrencyManager.release(nextConcurrencyKey)
        }
        task.failedFallbackRetryToken = retryToken
        return false
      }

      const sameSessionRetried = await args.onSameSessionRetry({
        task,
        sessionID: previousSessionID,
        source,
        failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
        failedError: errorInfo.message,
        nextModel,
      }).catch((error) => {
        deps.log("[background-agent] Same-session fallback retry failed:", {
          taskId: task.id,
          previousSessionID,
          nextModel: `${providerID}/${transformedModelId}`,
          error,
        })
        return false
      })

      if (sameSessionRetried) {
        if (previousConcurrencyKey && previousConcurrencyKey !== nextConcurrencyKey) {
          concurrencyManager.release(previousConcurrencyKey)
        }
        task.attemptCount = selectedAttemptCount
        task.model = nextModel
        task.status = "running"
        task.error = undefined
        task.completedAt = undefined
        task.sessionId = previousSessionID
        task.concurrencyKey = nextConcurrencyKey
        task.concurrencyGroup = nextConcurrencyKey
        task.retryNotification = undefined
        if (task.failedFallbackRetryToken === retryToken) {
          task.failedFallbackRetryToken = undefined
        }

        const currentAttempt = ensureCurrentAttempt(task, previousModel)
        currentAttempt.sessionId = previousSessionID
        currentAttempt.providerId = nextModel.providerID
        currentAttempt.modelId = nextModel.modelID
        currentAttempt.variant = nextModel.variant
        currentAttempt.status = "running"
        currentAttempt.error = undefined
        currentAttempt.completedAt = undefined

        onRetrying?.({
          task,
          source,
          previousSessionID,
          failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
          failedError: errorInfo.message,
          nextModel: `${providerID}/${transformedModelId}`,
        })

        await updateSessionTitleBestEffort({
          client,
          sessionID: previousSessionID,
          title: formatRetrySessionTitle(task.description, `retrying on ${providerID}/${transformedModelId}`),
          directory: args.directory,
          logFn: deps.log,
          logMessage: "[background-agent] Failed to mark same-session retrying session title:",
          logContext: {
            taskId: task.id,
            previousSessionID,
            nextModel: `${providerID}/${transformedModelId}`,
          },
          timeoutMs: args.titleUpdateTimeoutMs,
        })

        return true
      }

      if (shouldAcquireNextSlot) {
        concurrencyManager.release(nextConcurrencyKey)
      }
      task.failedFallbackRetryToken = retryToken
      return false
    }

    if (task.concurrencyKey) {
      concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    const idleTimer = idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleDeferralTimers.delete(task.id)
    }

    task.attemptCount = selectedAttemptCount
    const failedAttemptID = ensureCurrentAttempt(task, previousModel).attemptId
    const nextAttempt = failedAttemptID
      ? scheduleRetryAttempt(task, failedAttemptID, nextModel, errorInfo.message)
      : undefined
    if (!nextAttempt) {
      return false
    }

    task.queuedAt = new Date()
    task.retryNotification = {
      previousSessionID,
      failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
      failedError: errorInfo.message,
      nextModel: `${providerID}/${transformedModelId}`,
    }
    if (task.failedFallbackRetryToken === retryToken) {
      task.failedFallbackRetryToken = undefined
    }

    onRetrying?.({
      task,
      source,
      previousSessionID,
      failedModel: task.retryNotification.failedModel,
      failedError: errorInfo.message,
      nextModel: `${providerID}/${transformedModelId}`,
    })

    const key = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent
    const queue = queuesByKey.get(key) ?? []
    const retryInput: LaunchInput = {
      description: task.description,
      prompt: task.prompt,
      agent: task.agent,
      parentSessionId: task.parentSessionId,
      parentMessageId: task.parentMessageId,
      parentModel: task.parentModel,
      parentAgent: task.parentAgent,
      parentTools: task.parentTools,
      teamRunId: task.teamRunId,
      model: nextModel,
      fallbackChain: task.fallbackChain,
      skillContent: task.skillContent,
      sessionPermission: task.sessionPermission,
      category: task.category,
      isUnstableAgent: task.isUnstableAgent,
      onSessionCreated: task.onSessionCreated,
      userPermission: task.userPermission,
    }

    if (previousSessionID) {
      await updateSessionTitleBestEffort({
        client,
        sessionID: previousSessionID,
        title: formatRetrySessionTitle(task.description, `retrying on ${providerID}/${transformedModelId}`),
        directory: args.directory,
        logFn: deps.log,
        logMessage: "[background-agent] Failed to mark retrying session title:",
        logContext: {
          taskId: task.id,
          previousSessionID,
          nextModel: `${providerID}/${transformedModelId}`,
        },
        timeoutMs: args.titleUpdateTimeoutMs,
      })
    }

    queue.push({ task, input: retryInput, attemptID: nextAttempt.attemptId, rawConcurrencyKey: key })
    queuesByKey.set(key, queue)
    processKey(key)
    return true
  })

  fallbackRetryInFlight.set(task, { token: retryToken, promise: retryPromise })
  try {
    return await retryPromise
  } finally {
    if (fallbackRetryInFlight.get(task)?.promise === retryPromise) {
      fallbackRetryInFlight.delete(task)
    }
  }
}

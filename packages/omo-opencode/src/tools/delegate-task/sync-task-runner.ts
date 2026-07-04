import type { TaskToastManager } from "../../features/task-toast-manager/manager"
import type { ModelFallbackState } from "../../hooks/model-fallback/hook"
import type { FallbackEntry } from "../../shared/model-requirements"
import { shouldRetryError } from "../../shared/model-error-classifier"
import { getDeliverableTag } from "./constants"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { buildRecoveredSyncTaskCompletion, buildSyncTaskCompletion } from "./sync-completion-message"
import { shouldAttemptPollErrorRecovery } from "./sync-poll-error-recovery"
import type { SyncTaskDeps } from "./sync-task-deps"
import { getNextSyncFallbackModel, retrySyncPromptWithFallbacks } from "./sync-task-fallback"
import type { DelegatedModelConfig, DelegateTaskArgs, ToolContextWithMetadata } from "./types"

type SyncTaskRunnerInput = {
  readonly args: DelegateTaskArgs
  readonly ctx: ToolContextWithMetadata
  readonly executorCtx: ExecutorContext
  readonly parentContext: ParentContext
  readonly agentToUse: string
  readonly categoryModel: DelegatedModelConfig | undefined
  readonly fallbackChain: FallbackEntry[] | undefined
  readonly deps: SyncTaskDeps
  readonly sessionID: string
  readonly spawnDepth: number
  readonly taskId: string
  readonly startTime: Date
  readonly syncPollTimeoutMs: number | undefined
  readonly systemContent: string | undefined
  readonly toastManager: TaskToastManager | undefined
  readonly registerSyncSession: (
    newSessionID: string,
    currentModel?: DelegatedModelConfig,
    notifySessionCreated?: boolean,
  ) => Promise<void>
  readonly publishSyncMetadata: (
    currentSessionID: string,
    currentModel: DelegatedModelConfig | undefined,
    spawnDepth: number,
  ) => Promise<void>
}

function shouldRetryPollErrorWithFallback(pollError: string, deps: SyncTaskDeps): boolean {
  const errorInfo = { message: pollError }
  return shouldRetryError(errorInfo) || (deps.isProviderExhaustionFallbackEligible?.(errorInfo) ?? false)
}

export async function runSyncTaskLoop(input: SyncTaskRunnerInput): Promise<string> {
  const {
    args,
    ctx,
    executorCtx,
    parentContext,
    agentToUse,
    fallbackChain,
    deps,
    spawnDepth,
    taskId,
    startTime,
    syncPollTimeoutMs,
    systemContent,
    toastManager,
    registerSyncSession,
    publishSyncMetadata,
  } = input
  const { client, directory, sisyphusAgentConfig } = executorCtx
  const hasActiveChildBackgroundTasks = executorCtx.manager?.hasActiveChildTasks?.bind(executorCtx.manager)
  const hasPendingParentWake = executorCtx.manager?.hasPendingParentWake?.bind(executorCtx.manager)
  const deliverableTag = getDeliverableTag(agentToUse)
  let effectiveCategoryModel = input.categoryModel
  let fallbackState: ModelFallbackState | undefined = effectiveCategoryModel && fallbackChain?.length
    ? {
        providerID: effectiveCategoryModel.providerID,
        modelID: effectiveCategoryModel.modelID,
        fallbackChain,
        attemptCount: 0,
        pending: true,
      }
    : undefined
  let activeSessionID = input.sessionID
  let anchorMessageCount: number | undefined
  let fallbackPromptPending = false

  const prepareFallbackPrompt = async (fallbackModel: DelegatedModelConfig): Promise<string | null> => {
    await registerSyncSession(activeSessionID, fallbackModel, false)
    const anchorResult = await deps.getSyncMessageCount?.(client, activeSessionID)
    if (!anchorResult) {
      return `Unable to safely retry fallback because the session message anchor is unavailable.\n\nSession ID: ${activeSessionID}`
    }
    if (!anchorResult.ok) {
      return anchorResult.error
    }
    anchorMessageCount = anchorResult.count
    return null
  }

  while (true) {
    if (fallbackPromptPending && effectiveCategoryModel) {
      const anchorError = await prepareFallbackPrompt(effectiveCategoryModel)
      if (anchorError) {
        return anchorError
      }
      fallbackPromptPending = false
    }

    let promptError = await deps.sendSyncPrompt(client, {
      sessionID: activeSessionID,
      agentToUse,
      args,
      systemContent,
      directory,
      toastManager,
      taskId,
      sisyphusAgentConfig,
      categoryModel: effectiveCategoryModel,
    })
    if (promptError) {
      const promptResult = await retrySyncPromptWithFallbacks({
        sessionID: activeSessionID,
        initialError: promptError,
        categoryModel: effectiveCategoryModel,
        fallbackChain,
        sendPrompt: async (fallbackModel) => {
          const anchorError = await prepareFallbackPrompt(fallbackModel)
          if (anchorError) {
            return anchorError
          }
          return deps.sendSyncPrompt(client, {
            sessionID: activeSessionID,
            agentToUse,
            args,
            systemContent,
            directory,
            toastManager,
            taskId,
            sisyphusAgentConfig,
            categoryModel: fallbackModel,
          })
        },
      })

      promptError = promptResult.promptError
      effectiveCategoryModel = promptResult.categoryModel
      fallbackState = promptResult.fallbackState ?? fallbackState

      if (promptError) {
        return promptError
      }
    }

    const pollError = await deps.pollSyncSession(ctx, client, {
      sessionID: activeSessionID,
      agentToUse,
      toastManager,
      taskId,
      anchorMessageCount,
      hasActiveChildBackgroundTasks,
      hasPendingParentWake,
    }, syncPollTimeoutMs)
    if (pollError) {
      if (shouldAttemptPollErrorRecovery(pollError)) {
        const recoveredResult = await deps.fetchSyncResult(client, activeSessionID, anchorMessageCount, {
          strictAbortRecovery: true,
          deliverableTag,
        })
        if (recoveredResult.ok) {
          return buildRecoveredSyncTaskCompletion({
            activeSessionID,
            agentToUse,
            args,
            effectiveCategoryModel,
            parentContext,
            startTime,
            textContent: recoveredResult.textContent,
          })
        }
      }

      const nextFallbackModel = shouldRetryPollErrorWithFallback(pollError, deps)
        ? getNextSyncFallbackModel(activeSessionID, fallbackState)
        : null
      if (!nextFallbackModel) {
        return pollError
      }

      effectiveCategoryModel = nextFallbackModel
      await publishSyncMetadata(activeSessionID, effectiveCategoryModel, spawnDepth)
      fallbackPromptPending = true
      continue
    }

    const result = await deps.fetchSyncResult(client, activeSessionID, anchorMessageCount, { deliverableTag })
    if (!result.ok) {
      return result.error
    }

    await publishSyncMetadata(activeSessionID, effectiveCategoryModel, spawnDepth)

    return buildSyncTaskCompletion({
      activeSessionID,
      agentToUse,
      args,
      effectiveCategoryModel,
      parentContext,
      startTime,
      textContent: result.textContent,
    })
  }
}

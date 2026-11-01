import type { TaskToastManager } from "../../features/task-toast-manager/manager"
import { archiveBackgroundTask } from "../../features/background-agent/task-registry"
import type { ModelFallbackState } from "../../hooks/model-fallback/hook"
import type { FallbackEntry } from "../../shared/model-requirements"
import { shouldRetryError } from "../../shared/model-error-classifier"
import { hasNativeRuntimeFallback } from "../../hooks/runtime-fallback/native-controller"
import { getDeliverableTag } from "./constants"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { buildRecoveredSyncTaskCompletion, buildSyncTaskCompletion } from "./sync-completion-message"
import { shouldAttemptPollErrorRecovery } from "./sync-poll-error-recovery"
import type { SyncTaskDeps } from "./sync-task-deps"
import { getNextSyncFallbackModel, retrySyncPromptWithFallbacks } from "./sync-task-fallback"
import { isSyncPollTimeout } from "./sync-session-poller"
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
  readonly handOffTimedOutSession?: (sessionID: string, pollMessage: string) => Promise<string | undefined>
}

function shouldRetryPollErrorWithFallback(pollError: string, deps: SyncTaskDeps): boolean {
  const errorInfo = { message: pollError }
  return shouldRetryError(errorInfo) || (deps.isProviderExhaustionFallbackEligible?.(errorInfo) ?? false)
}

/** Polls (one poll interval each) that a native-owned child may stay on the same failure before it is final. */
export const NATIVE_RECOVERY_POLL_LIMIT = 30

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
    handOffTimedOutSession,
  } = input
  const { client, directory, sisyphusAgentConfig } = executorCtx
  const hasActiveChildBackgroundTasks = executorCtx.manager?.hasActiveChildTasks?.bind(executorCtx.manager)
  const hasPendingParentWake = executorCtx.manager?.hasPendingParentWake?.bind(executorCtx.manager)
  const deliverableTag = getDeliverableTag(agentToUse)
  let effectiveCategoryModel = input.categoryModel
  let fallbackState: ModelFallbackState | undefined =
    effectiveCategoryModel && fallbackChain?.length
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
  let awaitingNativeRecovery = false
  let nativeRecoveryError: string | undefined
  let nativeRecoveryPolls = 0

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

    let promptError = awaitingNativeRecovery
      ? null
      : await deps.sendSyncPrompt(client, {
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

    const pollError = await deps.pollSyncSession(
      ctx,
      client,
      {
        sessionID: activeSessionID,
        agentToUse,
        toastManager,
        taskId,
        anchorMessageCount,
        hasActiveChildBackgroundTasks,
        hasPendingParentWake,
      },
      syncPollTimeoutMs,
    )
    if (isSyncPollTimeout(pollError)) {
      // The child is still working: a parent poll budget is not a model failure to retry.
      return (await handOffTimedOutSession?.(activeSessionID, pollError)) ?? pollError
    }
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

      // Native fallback continues this same session on the next model; re-prompting here would duplicate the task.
      if (hasNativeRuntimeFallback(client) && shouldRetryPollErrorWithFallback(pollError, deps)) {
        if (pollError !== nativeRecoveryError) nativeRecoveryPolls = 0
        nativeRecoveryError = pollError
        if (nativeRecoveryPolls >= NATIVE_RECOVERY_POLL_LIMIT) return pollError
        nativeRecoveryPolls++
        awaitingNativeRecovery = true
        continue
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

    if (!ctx.abort?.aborted) {
      archiveBackgroundTask({
        id: `sync_${activeSessionID}`,
        sessionId: activeSessionID,
        parentSessionId: parentContext.sessionID,
        parentMessageId: parentContext.messageID,
        parentAgent: parentContext.agent,
        description: args.description,
        prompt: args.prompt,
        agent: agentToUse,
        model: effectiveCategoryModel,
        category: args.category,
        spawnDepth,
        status: "completed",
        startedAt: startTime,
        completedAt: new Date(),
        concurrencyGroup: effectiveCategoryModel
          ? `${effectiveCategoryModel.providerID}/${effectiveCategoryModel.modelID}`
          : agentToUse,
      })
    }

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

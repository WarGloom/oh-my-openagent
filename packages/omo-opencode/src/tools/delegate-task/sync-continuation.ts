import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext, SessionMessage } from "./executor-types"
import { getDeliverableTag, isPlanFamily } from "./constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { getTaskToastManager } from "../../features/task-toast-manager"
import { getAgentToolRestrictions } from "../../shared/agent-tool-restrictions"
import { getMessageDir, normalizeSDKResponse } from "../../shared"
import { promptWithModelSuggestionRetry } from "../../shared/model-suggestion-retry"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { formatDuration } from "./time-formatter"
import { syncContinuationDeps, type SyncContinuationDeps } from "./sync-continuation-deps"
import { setSessionTools } from "../../shared/session-tools-store"
import { buildTaskPrompt } from "./prompt-builder"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { getTaskID } from "./task-id"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { log } from "../../shared/logger"
import { extractErrorStatusCode } from "../../features/background-agent/error-classifier"
import { cancelSyncSessionDeletion, scheduleSyncSessionDeletion } from "./sync-session-cleanup"
import type { BackgroundTask } from "../../features/background-agent/types"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { z } from "zod"
import { dispatchInternalPrompt } from "../../shared/prompt-async-gate"

type ResumeModel = { providerID: string; modelID: string }

type ResumeContext = {
  missingSession?: true
  resumeAgent?: string
  resumeModel?: ResumeModel
  resumeVariant?: string
  anchorMessageCount?: number
  anchorMessageID?: string
}

function shouldAttemptPollErrorRecovery(pollError: string): boolean {
  const trimmed = pollError.trim()

  if (trimmed.length === 0) {
    return false
  }

  if (/\bMessageAbortedError\b/u.test(trimmed)) {
    return true
  }

  if (/\bDOMException\b/u.test(trimmed) && /\bAbortError\b/u.test(trimmed)) {
    return true
  }

  if (/\bAbortError\b/u.test(trimmed) && !/\bTask aborted\b/u.test(trimmed)) {
    return true
  }

  if (/^the operation was aborted\.?$/iu.test(trimmed)) {
    return true
  }

  return false
}

async function resolveResumeContext(
  client: ExecutorContext["client"],
  continuationID: string
): Promise<ResumeContext> {
  try {
    const messagesResp = await client.session.messages({ path: { id: continuationID } })
    if (extractErrorStatusCode(messagesResp) === 404) return { missingSession: true }
    const messages = normalizeSDKResponse(messagesResp, [] as SessionMessage[])

    for (let index = messages.length - 1; index >= 0; index--) {
      const info = messages[index].info
      if (info?.agent || info?.model || (info?.modelID && info?.providerID)) {
        return {
          resumeAgent: info.agent,
          resumeModel: info.model ?? (info.providerID && info.modelID
            ? { providerID: info.providerID, modelID: info.modelID }
            : undefined),
          resumeVariant: info.variant,
          anchorMessageCount: messages.length,
          anchorMessageID: messages.at(-1)?.info?.id,
        }
      }
    }

    return { anchorMessageCount: messages.length, anchorMessageID: messages.at(-1)?.info?.id }
  } catch (error) {
    if (extractErrorStatusCode(error) === 404) return { missingSession: true }
    if (!(error instanceof Error)) throw error
    const resumeMessageDir = getMessageDir(continuationID)
    const { prevMessage } = await resolveMessageContext(continuationID, client, resumeMessageDir)
    const resumeMessageModel = prevMessage?.model

    return {
      resumeAgent: prevMessage?.agent,
      resumeModel: resumeMessageModel?.providerID && resumeMessageModel.modelID
        ? { providerID: resumeMessageModel.providerID, modelID: resumeMessageModel.modelID }
        : undefined,
      resumeVariant: resumeMessageModel?.variant,
    }
  }
}

export async function executeSyncContinuation(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  deps: SyncContinuationDeps = syncContinuationDeps,
  systemContent?: string,
  retainedTask?: BackgroundTask,
): Promise<string> {
  const { client, syncPollTimeoutMs, sisyphusAgentConfig } = executorCtx
  const hasActiveChildBackgroundTasks = executorCtx.manager?.hasActiveChildTasks?.bind(executorCtx.manager)
  const hasPendingParentWake = executorCtx.manager?.hasPendingParentWake?.bind(executorCtx.manager)
  const toastManager = getTaskToastManager()
  const continuationID = getTaskID(args)
  if (!continuationID) {
    throw new Error("task_id is required to continue a sync task")
  }
  const releaseSyncClaim = executorCtx.manager?.claimSyncContinuation?.(continuationID, parentContext.sessionID)
  const isManagedContinuation = releaseSyncClaim !== undefined
  const detachFromManager = !isManagedContinuation
    ? executorCtx.manager?.attachSyncContinuation?.(continuationID)
    : undefined
  if (!isManagedContinuation) {
    cancelSyncSessionDeletion(continuationID)
  }
  const taskId = `resume_sync_${continuationID.slice(0, 8)}`
  const startTime = new Date()

  if (toastManager) {
    toastManager.addTask({
      id: taskId,
      description: args.description,
      agent: "continue",
      isBackground: false,
    })
  }

  let resumeAgent: string | undefined
  let resumeModel: ResumeModel | undefined
  let resumeVariant: string | undefined
  let anchorMessageCount: number | undefined
  let anchorMessageID: string | undefined
  let handedBackToParent = false

  try {
    try {
      const resumeContext: ResumeContext = retainedTask
        ? { resumeAgent: retainedTask.agent, resumeModel: retainedTask.model, resumeVariant: retainedTask.model?.variant }
        : await resolveResumeContext(client, continuationID)
      if (retainedTask) {
        const messagesSchema = z.array(z.object({ info: z.object({ id: z.string().optional() }) }))
        const messages = z.union([messagesSchema, z.object({ data: messagesSchema, error: z.undefined().optional() }).transform((value) => value.data)]).parse(
          await client.session.messages({ path: { id: continuationID } }),
        )
        resumeContext.anchorMessageCount = messages.length
        resumeContext.anchorMessageID = messages.at(-1)?.info.id
      }
      if (resumeContext.missingSession) {
        toastManager?.removeTask(taskId)
        return `Session ${continuationID} no longer exists; cannot resume this session. Start a new task using saved task context.`
      }
      resumeAgent = resumeContext.resumeAgent
      resumeModel = resumeContext.resumeModel
      resumeVariant = resumeContext.resumeVariant
      anchorMessageCount = resumeContext.anchorMessageCount
      anchorMessageID = resumeContext.anchorMessageID

      const resumeModelForMetadata = resumeModel && resumeVariant !== undefined
        ? { ...resumeModel, variant: resumeVariant }
        : resumeModel

      const syncContMeta = {
        title: args.description,
        metadata: {
          prompt: args.prompt,
          ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.requested_subagent_type !== undefined ? { requested_subagent_type: args.requested_subagent_type } : {}),
          load_skills: args.load_skills,
          description: args.description,
          run_in_background: args.run_in_background,
          taskId: continuationID,
          sessionId: continuationID,
          sync: true,
          command: args.command,
          model: resolveMetadataModel(resumeModelForMetadata, parentContext.model),
        },
      }
      await publishToolMetadata(ctx, syncContMeta)

      const allowTask = isPlanFamily(resumeAgent)
      const tddEnabled = sisyphusAgentConfig?.tdd
      const effectivePrompt = buildTaskPrompt(args.prompt, resumeAgent, tddEnabled)
      const tools = {
        task: allowTask,
        call_omo_agent: true,
        question: false,
        ...(resumeAgent ? getAgentToolRestrictions(resumeAgent) : {}),
      }
      if (!retainedTask) setSessionTools(continuationID, tools)
      if (retainedTask?.model) applySessionPromptParams(continuationID, retainedTask.model)

      const promptInput = {
        path: { id: continuationID },
        body: {
          ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
          ...(resumeModel !== undefined ? { model: resumeModel } : {}),
          ...(resumeVariant !== undefined ? { variant: resumeVariant } : {}),
          system: systemContent,
          ...(!retainedTask ? { tools } : {}),
          parts: [{ type: "text" as const, text: effectivePrompt }],
        },
      }
      if (retainedTask) {
        const dispatch = await dispatchInternalPrompt({
          mode: "async", client, sessionID: continuationID, input: promptInput,
          source: "retained-session-continuation", queueBehavior: "defer", settleMs: 0, checkToolState: true,
        })
        if (dispatch.status === "failed") throw dispatch.error
        if (dispatch.status !== "dispatched") throw new Error(`Retained-session prompt skipped by gate: ${dispatch.status}`)
      } else {
        await promptWithModelSuggestionRetry(client, promptInput, { queueBehavior: "defer", checkToolState: false })
      }
    } catch (promptError) {
      if (toastManager) {
        toastManager.removeTask(taskId)
      }
      const errorMessage = promptError instanceof Error ? promptError.message : String(promptError)
      if (!isManagedContinuation) {
        scheduleSyncSessionDeletion(client, continuationID)
      }
      return `Failed to send continuation prompt: ${errorMessage}\n\nTask ID: ${continuationID}`
    }

    try {
      const pollError = await deps.pollSyncSession(ctx, client, {
        sessionID: continuationID,
        agentToUse: resumeAgent ?? "continue",
        toastManager,
        taskId,
        anchorMessageCount,
        anchorMessageID,
        hasActiveChildBackgroundTasks,
        hasPendingParentWake,
      }, syncPollTimeoutMs)
      if (pollError && shouldAttemptPollErrorRecovery(pollError)) {
        if (anchorMessageCount === undefined) {
          return pollError
        }
        const recoveredResult = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
          strictAbortRecovery: true,
          deliverableTag: getDeliverableTag(resumeAgent),
        })
        if (!recoveredResult.ok) {
          return pollError
        }

        const duration = formatDuration(startTime)
        handedBackToParent = true

        return `Task continued and completed in ${duration}.

---

${recoveredResult.textContent || "(No text output)"}

${buildTaskMetadataBlock({
          sessionId: continuationID,
          taskId: continuationID,
          agent: resumeAgent,
          category: args.category,
        })}`
      } else if (pollError) {
        return pollError
      }

      const result = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
        deliverableTag: getDeliverableTag(resumeAgent),
      })
      if (!result.ok) {
        return result.error
      }

     const duration = formatDuration(startTime)
     handedBackToParent = true

     return `Task continued and completed in ${duration}.

---

${result.textContent || "(No text output)"}

${buildTaskMetadataBlock({
        sessionId: continuationID,
        taskId: continuationID,
        agent: resumeAgent,
        category: args.category,
      })}`
   } finally {
     if (toastManager) {
       toastManager.removeTask(taskId)
     }
     if (handedBackToParent) {
       handedBackSyncSessions.add(continuationID)
       if (typeof client.session.abort === "function") {
         void client.session.abort({ path: { id: continuationID } }).catch((error: unknown) => {
           log(`[task] Failed to abort completed sync continuation session:`, error)
         })
       }
     }
      if (!isManagedContinuation) {
        scheduleSyncSessionDeletion(client, continuationID)
      }
    }
  } finally {
    releaseSyncClaim?.()
    detachFromManager?.()
  }
}

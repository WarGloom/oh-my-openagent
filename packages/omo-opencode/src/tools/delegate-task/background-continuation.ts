import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { formatDetailedError } from "./error-formatting"
import { getSessionTools } from "../../shared/session-tools-store"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { getTaskID } from "./task-id"
import { z } from "zod"
import { claimRetainedSessionRecovery } from "../../features/background-agent/task-registry"
import { executeSyncContinuation } from "./sync-continuation"

export async function executeBackgroundContinuation(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  systemContent?: string
): Promise<string> {
  const { manager } = executorCtx
  const taskID = getTaskID(args)

  try {
    if (!taskID) {
      throw new Error("task_id is required to continue a background task")
    }

    const task = await manager.resume({
      sessionId: taskID,
      prompt: args.prompt,
      system: systemContent,
      parentSessionId: parentContext.sessionID,
      parentMessageId: parentContext.messageID,
      parentModel: parentContext.model,
      parentAgent: parentContext.agent,
      parentTools: getSessionTools(parentContext.sessionID),
    }).catch(async (error: unknown) => {
      if (!(error instanceof Error) || error.message !== `Task not found for session: ${taskID}`) throw error
      return undefined
    })
    if (!task) {
      const claim = claimRetainedSessionRecovery(taskID, parentContext.sessionID)
      try {
        const sessionSchema = z.object({ id: z.literal(taskID), parentID: z.literal(parentContext.sessionID), error: z.undefined().optional() })
        z.union([sessionSchema, z.object({ data: sessionSchema, error: z.undefined().optional() })]).parse(
          await executorCtx.client.session.get({ path: { id: taskID } }),
        )
        const statuses = z.record(z.string(), z.object({ type: z.enum(["idle", "busy", "retry"]) }))
        const statusResponse = z.union([z.object({ data: statuses, error: z.undefined().optional() }).transform((value) => value.data), statuses]).parse(
          await executorCtx.client.session.status(),
        )
        if (statusResponse[taskID] && statusResponse[taskID].type !== "idle") throw new Error("Retained-session recovery denied: SDK session is busy.")
        const result = await executeSyncContinuation({ ...args, run_in_background: false }, ctx, executorCtx, parentContext, undefined, systemContent, claim.task)
        return `Synchronous recovery of retained session ${taskID}; no replacement agent or background task was created.\n\n${result}`
      } finally {
        claim.release()
      }
    }
    const sessionId = task.sessionId
    const backgroundTaskId = task.id
    const resolvedModel = resolveMetadataModel(task.model, parentContext.model)

    const bgContMeta = {
      title: args.description,
      metadata: {
        prompt: args.prompt,
        agent: task.agent,
        ...(task.category !== undefined ? { category: task.category } : {}),
        ...(args.requested_subagent_type !== undefined ? { requested_subagent_type: args.requested_subagent_type } : {}),
        load_skills: args.load_skills,
        description: args.description,
        run_in_background: args.run_in_background,
        taskId: sessionId,
        backgroundTaskId,
        sessionId,
        command: args.command,
        model: resolvedModel,
      },
    }
    await publishToolMetadata(ctx, bgContMeta)

    return `Background task continued.

Background Task ID: ${backgroundTaskId}
Description: ${task.description}
Agent: ${task.agent}
Status: ${task.status}

Agent continues with full previous context preserved.
Do NOT call background_output now. Wait for <system-reminder> notification first. The system will deliver the result when the task completes; you do not need to poll for it.

${buildTaskMetadataBlock({
      sessionId,
      backgroundTaskId,
      agent: task.agent,
      category: task.category,
    })}`
  } catch (error) {
    return formatDetailedError(error, {
      operation: "Continue background task",
      args,
      sessionID: taskID,
    })
  }
}

import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { formatDetailedError } from "./error-formatting"
import { getSessionTools } from "../../shared/session-tools-store"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { getTaskID } from "./task-id"
import { z } from "zod"
import { claimRetainedSessionRecovery, claimUnarchivedSessionRecovery, MISSING_RETAINED_TASK_ERROR } from "../../features/background-agent/task-registry"
import type { BackgroundTask } from "../../features/background-agent/types"
import { recoverUnarchivedTask } from "./unarchived-session-recovery"
import { assertTeamSessionCanContinue } from "../../features/team-mode/team-session-registry"

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
    assertTeamSessionCanContinue(taskID)

    const resumeInput = {
      sessionId: taskID,
      prompt: args.prompt,
      system: systemContent,
      parentSessionId: parentContext.sessionID,
      parentMessageId: parentContext.messageID,
      parentModel: parentContext.model,
      parentAgent: parentContext.agent,
      parentTools: getSessionTools(parentContext.sessionID),
    }
    let task = await manager.resume(resumeInput).catch(async (error: unknown) => {
      if (!(error instanceof Error) || error.message !== `Task not found for session: ${taskID}`) throw error
      return undefined
    })
    if (!task) {
      // The manager dropped the finished task but its SDK session was retained: re-register the
      // archived record so the continuation runs in the background under its original task ID.
      // After an OpenCode restart the archive is empty, so the record is rebuilt from the session.
      let archived: BackgroundTask | undefined
      let release: () => void
      try {
        const claim = claimRetainedSessionRecovery(taskID, parentContext.sessionID)
        archived = claim.task
        release = claim.release
      } catch (error) {
        if (!(error instanceof Error) || error.message !== MISSING_RETAINED_TASK_ERROR) throw error
        release = claimUnarchivedSessionRecovery(taskID, parentContext.sessionID).release
      }
      try {
        const sessionSchema = z.object({ id: z.literal(taskID), parentID: z.literal(parentContext.sessionID), title: z.string().optional(), error: z.undefined().optional() })
        const session = z.union([sessionSchema, z.object({ data: sessionSchema, error: z.undefined().optional() }).transform((value) => value.data)]).parse(
          await executorCtx.client.session.get({ path: { id: taskID } }),
        )
        const statuses = z.record(z.string(), z.object({ type: z.enum(["idle", "busy", "retry"]) }))
        const statusResponse = z.union([z.object({ data: statuses, error: z.undefined().optional() }).transform((value) => value.data), statuses]).parse(
          await executorCtx.client.session.status(),
        )
        if (statusResponse[taskID] && statusResponse[taskID].type !== "idle") throw new Error("Retained-session recovery denied: SDK session is busy.")
        manager.adoptRetainedTask(archived ?? await recoverUnarchivedTask(executorCtx.client, taskID, parentContext, session.title))
      } finally {
        release()
      }
      task = await manager.resume(resumeInput)
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

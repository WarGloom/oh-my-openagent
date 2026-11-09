import type { ExecutorContext } from "./executor-types"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { log } from "../../shared/logger"
import type { BackgroundTask } from "../../features/background-agent/types"

/**
 * Hands a sync child whose parent-side poll timed out to the background manager, so the
 * child keeps running and the parent receives the normal completion notification.
 * Returns the parent-facing message, or undefined when no manager can take the session.
 */
export async function handOffTimedOutSyncSession(input: {
  manager: ExecutorContext["manager"] | undefined
  sessionID: string
  parentSessionID: string
  description: string
  agent?: string
  parentAgent?: string
  category?: string
  pollMessage: string
  lifecycleTask?: BackgroundTask
}): Promise<string | undefined> {
  if (typeof input.manager?.adoptTimedOutSyncSession !== "function") return undefined

  try {
    const task = await input.manager.adoptTimedOutSyncSession({
      ...(input.lifecycleTask ? { lifecycleTask: input.lifecycleTask } : {}),
      sessionId: input.sessionID,
      parentSessionId: input.parentSessionID,
      description: input.description,
      agent: input.agent,
      parentAgent: input.parentAgent,
    })
    log("[task] Handed timed-out sync session to the background manager", {
      sessionID: input.sessionID,
      backgroundTaskId: task.id,
    })
    return `${input.pollMessage}

The subagent was not aborted. It keeps running as a background task.

Background Task ID: ${task.id}
Do NOT call background_output now. Wait for <system-reminder> notification first. The system will deliver the result when the task completes; you do not need to poll for it.

${buildTaskMetadataBlock({
  sessionId: input.sessionID,
  backgroundTaskId: task.id,
  agent: input.agent,
  category: input.category,
})}`
  } catch (error) {
    log("[task] Failed to hand timed-out sync session to the background manager", {
      sessionID: input.sessionID,
      error: String(error),
    })
    return undefined
  }
}

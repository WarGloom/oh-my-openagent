import type { BackgroundManager } from "../../features/background-agent/manager"
import type { BackgroundTask } from "../../features/background-agent/types"
import {
  claimRetainedSessionRecovery,
  claimUnarchivedSessionRecovery,
  MISSING_RETAINED_TASK_ERROR,
} from "../../features/background-agent/task-registry"
import { assertTeamSessionCanContinue } from "../../features/team-mode/team-session-registry"

export async function claimNativeContinuation(manager: BackgroundManager, sessionID: string, parentSessionID: string) {
  assertTeamSessionCanContinue(sessionID)
  const active = manager.findBySession(sessionID)
  if (active) {
    if (active.parentSessionId !== parentSessionID) throw new Error("Task belongs to a different parent session")
    return { task: active, release: () => {} }
  }
  let archived: BackgroundTask | undefined
  let release: () => void
  try {
    const claim = claimRetainedSessionRecovery(sessionID, parentSessionID, "native-terminal")
    archived = claim.task
    release = claim.release
  } catch (error) {
    if (!(error instanceof Error) || error.message !== MISSING_RETAINED_TASK_ERROR) throw error
    release = claimUnarchivedSessionRecovery(sessionID, parentSessionID).release
  }
  try {
    const task = await manager.nativeJobs?.recover?.(sessionID, parentSessionID, archived)
    if (!task) throw new Error(`Task not found for session: ${sessionID}`)
    assertTeamSessionCanContinue(sessionID)
    manager.adoptRetainedTask(task)
    return { task, release }
  } catch (error) {
    release()
    throw error
  }
}

import { TASK_CLEANUP_DELAY_MS } from "../../features/background-agent/constants"
import { handedBackSyncSessions } from "../../features/claude-code-session-state"
import type { OpencodeClient } from "./types"

const pendingDeletionTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function cancelSyncSessionDeletion(sessionID: string): void {
  const timer = pendingDeletionTimers.get(sessionID)
  if (!timer) return
  clearTimeout(timer)
  pendingDeletionTimers.delete(sessionID)
}

export function scheduleSyncSessionDeletion(
  _client: OpencodeClient,
  sessionID: string,
  delayMs = TASK_CLEANUP_DELAY_MS,
): void {
  cancelSyncSessionDeletion(sessionID)
  const timer = setTimeout(() => {
    pendingDeletionTimers.delete(sessionID)
    // Keep the SDK session available for later task_id resumption.
    handedBackSyncSessions.delete(sessionID)
  }, delayMs)
  pendingDeletionTimers.set(sessionID, timer)
  timer.unref()
}

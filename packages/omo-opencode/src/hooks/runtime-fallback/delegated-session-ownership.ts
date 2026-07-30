import {
  delegatedTaskSessions,
  subagentSessions,
  syncSubagentSessions,
} from "../../features/claude-code-session-state"

export function isDelegatedSessionOwnedByTask(sessionID: string): boolean {
  return subagentSessions.has(sessionID)
    || syncSubagentSessions.has(sessionID)
    || delegatedTaskSessions.has(sessionID)
}

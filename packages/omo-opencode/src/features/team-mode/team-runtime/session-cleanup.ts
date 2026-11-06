import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { deleteTeam } from "./delete-team"
import type { DeleteTeamBackgroundManager } from "./delete-team"
import type { KeptMemberWorktree } from "./shutdown-helpers"
import {
  getSessionCreatedTeamRunIds,
  unregisterTeamRunForSessionCleanup,
} from "./session-team-run-registry"

export {
  clearSessionTeamRunCleanupRegistry,
  getSessionCreatedTeamRunIds,
  registerTeamRunForSessionCleanup,
  unregisterTeamRunForSessionCleanup,
} from "./session-team-run-registry"

export type SessionTeamCleanupReport = {
  cleanedTeamRunIds: string[]
  removedLayoutTeamRunIds: string[]
  keptWorktrees: KeptMemberWorktree[]
  errors: string[]
}

export type SessionTeamCleanupDeps = {
  deleteTeam: typeof deleteTeam
  log: typeof log
}

const defaultSessionTeamCleanupDeps: SessionTeamCleanupDeps = {
  deleteTeam,
  log,
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function cleanupSessionTeamRuns(args: {
  config: TeamModeConfig
  tmuxMgr?: TmuxSessionManager
  bgMgr?: DeleteTeamBackgroundManager
  deps?: SessionTeamCleanupDeps
}): Promise<SessionTeamCleanupReport> {
  const deps = args.deps ?? defaultSessionTeamCleanupDeps
  const report: SessionTeamCleanupReport = {
    cleanedTeamRunIds: [],
    removedLayoutTeamRunIds: [],
    keptWorktrees: [],
    errors: [],
  }

  for (const teamRunId of getSessionCreatedTeamRunIds()) {
    try {
      const result = await deps.deleteTeam(teamRunId, args.config, args.tmuxMgr, args.bgMgr, { force: true, worktreeCleanup: "preserve" })
      report.keptWorktrees.push(...result.keptWorktrees ?? [])
      report.cleanedTeamRunIds.push(teamRunId)
      if (result.removedLayout) {
        report.removedLayoutTeamRunIds.push(teamRunId)
      }
    } catch (error) {
      const normalizedError = normalizeError(error)
      report.errors.push(`${teamRunId}: ${normalizedError.message}`)
      deps.log("session team cleanup failed", {
        teamRunId,
        error: normalizedError.message,
      })
    } finally {
      unregisterTeamRunForSessionCleanup(teamRunId)
    }
  }

  return report
}

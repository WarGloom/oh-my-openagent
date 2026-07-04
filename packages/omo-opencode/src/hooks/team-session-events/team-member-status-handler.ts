import type { TeamModeConfig } from "../../config/schema/team-mode"
import type { BackgroundTask } from "../../features/background-agent/types"
import { findResolvedMemberSession } from "../../features/team-mode/member-session-resolution"
import { loadRuntimeState, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeStateMember } from "../../features/team-mode/types"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { log } from "../../shared/logger"

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>

type MemberStatus = RuntimeStateMember["status"]
type ManagedBackgroundTask = Pick<BackgroundTask, "status" | "teamRunId">
type TeamMemberStatusHandlerDeps = {
  backgroundManager?: {
    findBySession: (sessionID: string) => ManagedBackgroundTask | undefined
    getFallbackRetryResult?: (sessionID: string) => Promise<boolean> | undefined
    consumeFallbackRetryResult?: (sessionID: string) => Promise<boolean> | undefined
    hasValidSessionOutput?: (sessionID: string) => Promise<boolean>
  }
}

const IDLE_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running"])
const COMPLETED_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running", "idle", "pending"])

function getSessionIDFromIdleEvent(properties: unknown): string | undefined {
  return resolveSessionEventID(properties)
}

function getSessionIDFromDeletedEvent(properties: unknown): string | undefined {
  return resolveSessionEventID(properties)
}

async function transitionMemberStatus(
  runtimeMember: { teamRunId: string; memberName: string },
  allowedSources: ReadonlySet<MemberStatus>,
  nextStatus: MemberStatus,
  config: TeamModeConfig,
  sessionID: string,
  eventLabel: string,
): Promise<void> {
  const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
  const currentEntry = runtimeState.members.find((member) => member.name === runtimeMember.memberName)
  if (currentEntry === undefined) return
  if (!allowedSources.has(currentEntry.status)) return

  await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
    ...currentRuntimeState,
    members: currentRuntimeState.members.map((member) => (
      member.name === runtimeMember.memberName
        ? { ...member, status: nextStatus }
        : member
    )),
  }), config)

  log(`team member ${eventLabel}`, {
    event: `team-mode-member-${eventLabel}`,
    teamRunId: runtimeState.teamRunId,
    teamName: runtimeState.teamName,
    memberName: runtimeMember.memberName,
    sessionID,
    previousStatus: currentEntry.status,
    nextStatus,
  })
}

async function shouldKeepBackgroundManagedMemberRunning(
  deps: TeamMemberStatusHandlerDeps,
  sessionID: string,
  teamRunId: string,
): Promise<boolean> {
  const task = deps.backgroundManager?.findBySession(sessionID)
  if (!task || task.teamRunId !== teamRunId) {
    return false
  }

  if (task.status !== "pending" && task.status !== "running") {
    return false
  }

  const retryResult = deps.backgroundManager?.consumeFallbackRetryResult?.(sessionID)
    ?? deps.backgroundManager?.getFallbackRetryResult?.(sessionID)
  if (retryResult) {
    const retried = await retryResult.catch((error) => {
      log("team member background fallback result failed during idle status", {
        event: "team-mode-member-idle-background-fallback-result-failed",
        teamRunId,
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    })
    if (retried) return true
  }

  const hasValidOutput = await deps.backgroundManager?.hasValidSessionOutput?.(sessionID)
  return hasValidOutput === false
}

export function createTeamMemberStatusHandler(
  config: TeamModeConfig,
  deps: TeamMemberStatusHandlerDeps = {},
): HookImpl {
  return async ({ event }: HookInput): Promise<void> => {
    if (event.type === "session.idle") {
      const sessionID = getSessionIDFromIdleEvent(event.properties)
      if (!sessionID) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        if (await shouldKeepBackgroundManagedMemberRunning(deps, sessionID, runtimeMember.teamRunId)) {
          log("team member idle deferred to background task", {
            event: "team-mode-member-idle-background-managed",
            teamRunId: runtimeMember.teamRunId,
            memberName: runtimeMember.memberName,
            sessionID,
          })
          return
        }
        await transitionMemberStatus(runtimeMember, IDLE_TRANSITION_SOURCE_STATUSES, "idle", config, sessionID, "idled")
      } catch (error) {
        log("team member status handler failed on session.idle", {
          event: "team-mode-member-status-handler-error",
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionIDFromDeletedEvent(event.properties)
      if (!sessionID) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        await transitionMemberStatus(runtimeMember, COMPLETED_TRANSITION_SOURCE_STATUSES, "completed", config, sessionID, "completed")
      } catch (error) {
        log("team member status handler failed on session.deleted", {
          event: "team-mode-member-status-handler-error",
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}

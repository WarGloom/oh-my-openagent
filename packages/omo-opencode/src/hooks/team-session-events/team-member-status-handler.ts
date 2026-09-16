import type { TeamModeConfig } from "../../config/schema/team-mode"
import { isActiveSessionStatus } from "../../features/background-agent/session-status-classifier"
import type { BackgroundTask } from "../../features/background-agent/types"
import { findResolvedMemberSession } from "../../features/team-mode/member-session-resolution"
import { withInboxConsumerLease } from "../../features/team-mode/team-mailbox"
import { lookupTeamSession } from "../../features/team-mode/team-session-registry"
import { loadRuntimeState, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeStateMember } from "../../features/team-mode/types"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { log } from "../../shared/logger"
import { captureTerminalSettlementRecoveryCheck } from "./pending-claim-settlement"

type HookInput = {
  event: { type: string; properties?: unknown }
  canRecoverFromError?: () => boolean
}
export type HookImpl = (input: HookInput) => Promise<void>

type MemberStatus = RuntimeStateMember["status"]
type ManagedBackgroundTask = Pick<BackgroundTask, "status" | "teamRunId"> & Partial<Pick<BackgroundTask, "id" | "sessionId" | "currentAttemptID">>
type TeamMemberStatusHandlerDeps = {
  backgroundManager?: {
    findBySession: (sessionID: string) => ManagedBackgroundTask | undefined
    getFallbackRetryResult?: (sessionID: string) => Promise<boolean> | undefined
    consumeFallbackRetryResult?: (sessionID: string) => Promise<boolean> | undefined
    hasValidSessionOutput?: (sessionID: string) => Promise<boolean>
  }
}

const IDLE_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running", "errored"])
const COMPLETED_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running", "idle", "pending"])
const ACTIVE_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["pending", "idle", "errored"])

function getSessionStatusType(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null || !("status" in properties)) return undefined
  const status = properties.status
  if (typeof status !== "object" || status === null || !("type" in status)) return undefined
  return typeof status.type === "string" ? status.type : undefined
}

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
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
  const currentEntry = runtimeState.members.find((member) => member.name === runtimeMember.memberName)
  if (currentEntry === undefined) return
  if (!allowedSources.has(currentEntry.status)) return

  let transitioned = false
  const commitTransition = () => transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => {
    if (!isCurrent() || (currentRuntimeState.status !== "active" && currentRuntimeState.status !== "creating")) return currentRuntimeState
    const registered = lookupTeamSession(sessionID)
    const isSpawnRace = registered?.teamRunId === runtimeMember.teamRunId && registered.memberName === runtimeMember.memberName
    return {
      ...currentRuntimeState,
      members: currentRuntimeState.members.map((member) => {
        if (member.name !== runtimeMember.memberName || !allowedSources.has(member.status)) return member
        if (member.sessionId !== sessionID && !(member.sessionId === undefined && isSpawnRace)) return member
        transitioned = true
        return { ...member, status: nextStatus }
      }),
    }
  }, config)
  if (currentEntry.status === "errored") {
    if (!isCurrent()) return
    await withInboxConsumerLease(runtimeState.teamRunId, runtimeMember.memberName, config, commitTransition, { staleAfterMs: 0 })
  } else {
    await commitTransition()
  }

  if (!transitioned) return
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
  return async ({ event, canRecoverFromError }: HookInput): Promise<void> => {
    const recoverySessionID = resolveSessionEventID(event.properties)
    if (!recoverySessionID) return
    const recoveryIsCurrent = canRecoverFromError ?? captureTerminalSettlementRecoveryCheck(recoverySessionID)
    if (event.type === "session.status") {
      const sessionID = resolveSessionEventID(event.properties)
      const statusType = getSessionStatusType(event.properties)
      if (!sessionID || !statusType || !isActiveSessionStatus(statusType)) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        await transitionMemberStatus(runtimeMember, ACTIVE_TRANSITION_SOURCE_STATUSES, "running", config, sessionID, "running", recoveryIsCurrent)
      } catch (error) {
        log("team member status handler failed on session.status", {
          event: "team-mode-member-status-handler-error",
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (event.type === "session.idle") {
      const sessionID = getSessionIDFromIdleEvent(event.properties)
      if (!sessionID) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        const task = deps.backgroundManager?.findBySession(sessionID)
        if (task?.teamRunId === runtimeMember.teamRunId && task.status === "error") {
          const { id, currentAttemptID } = task
          await transitionMemberStatus(runtimeMember, COMPLETED_TRANSITION_SOURCE_STATUSES, "errored", config, sessionID, "errored", () => {
            const current = deps.backgroundManager?.findBySession(sessionID)
            return current !== undefined && current.id === id && current.currentAttemptID === currentAttemptID
              && current.teamRunId === runtimeMember.teamRunId && current.status === "error"
              && (current.sessionId === undefined || current.sessionId === sessionID)
          })
          return
        }
        if (await shouldKeepBackgroundManagedMemberRunning(deps, sessionID, runtimeMember.teamRunId)) {
          log("team member idle deferred to background task", {
            event: "team-mode-member-idle-background-managed",
            teamRunId: runtimeMember.teamRunId,
            memberName: runtimeMember.memberName,
            sessionID,
          })
          return
        }
        await transitionMemberStatus(runtimeMember, IDLE_TRANSITION_SOURCE_STATUSES, "idle", config, sessionID, "idled", recoveryIsCurrent)
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

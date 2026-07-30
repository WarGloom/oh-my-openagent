import type { TeamModeConfig } from "../../config/schema/team-mode"
import { findResolvedMemberSession } from "../../features/team-mode/member-session-resolution"
import {
  applyMemberSessionRouting,
  buildMemberPromptBody,
} from "../../features/team-mode/member-session-routing"
import { loadRuntimeState } from "../../features/team-mode/team-state-store/store"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { isAmbiguousPostDispatchPromptFailure } from "../../shared/prompt-failure-classifier"
import { log } from "../../shared/logger"
import { isSessionActive, settleAfterSessionIdle } from "../../shared/session-idle-settle"
import {
  dispatchInternalPrompt,
  isInternalPromptDispatchAccepted,
  type InternalPromptDispatchResult,
} from "../shared/prompt-async-gate"
import { settleIdleClaims, type IdleClaimSettlement } from "./pending-claim-settlement"
import {
  recordReservedMailboxBatchPending,
  releaseReservedMailboxBatch,
  reserveUnreadMailboxBatch,
} from "./reserved-mailbox-batch"

type PromptAsyncInput = {
  path: { id: string }
  body: {
    parts: Array<{ type: "text"; text: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }
  query: { directory: string }
}

type TeamIdleWakeHintContext = {
  directory: string
  client: {
    session: {
      promptAsync?: (input: PromptAsyncInput) => Promise<unknown>
      status?: () => Promise<unknown>
      messages?: (input: { path: { id: string } }) => Promise<unknown>
    }
  }
}

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>
type TeamIdleWakeHintOptions = {
  idleSettleMs?: number
  postDispatchHoldMs?: number
}
const WAKE_HINT_DUPLICATE_SUPPRESSION_MS = 30_000

export function createTeamIdleWakeHint(ctx: TeamIdleWakeHintContext, config: TeamModeConfig, options?: TeamIdleWakeHintOptions): HookImpl {
  const recentWakeHintBatches = new Map<string, number>()

  return async ({ event }: HookInput): Promise<void> => {
    if (event.type !== "session.idle") return

    const sessionID = resolveSessionEventID(event.properties)
    if (!sessionID) return

    try {
      const runtimeMember = await findResolvedMemberSession(sessionID, config, "team idle wake hint")
      if (runtimeMember === null) {
        return
      }

      const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
      const memberEntry = runtimeState.members.find((member) => member.name === runtimeMember.memberName)
      if (!memberEntry) {
        return
      }

      const pendingInjectedMessageIds = [...memberEntry.pendingInjectedMessageIds]
      let claimSettlement: IdleClaimSettlement = { kind: "settled", ackedCount: 0, requeuedCount: 0, unresolvedCount: 0 }
      if (pendingInjectedMessageIds.length > 0) {
        if (typeof ctx.client.session.status === "function") {
          await settleAfterSessionIdle(options?.idleSettleMs ?? 0)
          if (await isSessionActive(ctx.client, sessionID)) {
            log("team idle pending ack skipped while session remains active", {
              event: "team-mode-idle-pending-ack-active",
              teamRunId: runtimeState.teamRunId,
              memberName: memberEntry.name,
              sessionID,
              pendingCount: pendingInjectedMessageIds.length,
            })
            return
          }
        }

        claimSettlement = await settleIdleClaims({
          teamRunId: runtimeState.teamRunId,
          memberName: memberEntry.name,
          sessionID,
          config,
          client: ctx.client,
        })
        if (claimSettlement.kind === "stale-session") return
        if (claimSettlement.ackedCount + claimSettlement.requeuedCount + claimSettlement.unresolvedCount > 0) {
          log("team idle handled pending live delivery ack", {
            event: "team-mode-idle-pending-ack",
            teamRunId: runtimeState.teamRunId,
            memberName: memberEntry.name,
            sessionID,
            ackedCount: claimSettlement.ackedCount,
            requeuedCount: claimSettlement.requeuedCount,
            unresolvedCount: claimSettlement.unresolvedCount,
          })
        }
      }

      const latestRuntimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
      const latestMemberEntry = latestRuntimeState.members.find((member) => member.name === runtimeMember.memberName)
      if (!latestMemberEntry) {
        return
      }
      const spawnRaceStillPending = runtimeMember.sessionId === undefined && latestMemberEntry.sessionId === undefined
      if (!spawnRaceStillPending && (
        runtimeMember.sessionId !== sessionID || latestMemberEntry.sessionId !== sessionID
      )) {
        return
      }
      if (
        latestMemberEntry.status === "errored"
        || latestMemberEntry.status === "completed"
        || latestMemberEntry.status === "shutdown_approved"
      ) {
        log("team idle wake hint skipped because member is no longer idle", {
          event: "team-mode-idle-member-not-idle",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          status: latestMemberEntry.status,
        })
        return
      }

      if (typeof ctx.client.session.promptAsync !== "function") {
        log("team idle wake hint skipped without promptAsync", {
          event: "team-mode-idle-wake-hint-skipped",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
        })
        return
      }

      const reservedBatch = await reserveUnreadMailboxBatch({
        teamRunId: latestRuntimeState.teamRunId,
        memberName: latestMemberEntry.name,
        config,
      })
      if (reservedBatch === null) {
        log("team idle handled without wake hint", {
          event: "team-mode-idle-ack-only",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          ackedCount: claimSettlement.ackedCount,
          requeuedCount: claimSettlement.requeuedCount,
        })
        return
      }

      const now = Date.now()
      const sortedMessageIds = [...reservedBatch.messageIds].sort().join(",")
      const wakeHintBatchKey = `${runtimeMember.teamRunId}:${runtimeMember.memberName}:${sessionID}:${sortedMessageIds}`
      const suppressedUntil = recentWakeHintBatches.get(wakeHintBatchKey)
      if (suppressedUntil !== undefined && suppressedUntil > now) {
        await releaseReservedMailboxBatch(reservedBatch)
        log("team idle wake hint skipped for recently hinted unread batch", {
          event: "team-mode-idle-wake-hint-duplicate-suppressed",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          unreadCount: reservedBatch.messageIds.length,
        })
        return
      }
      if (suppressedUntil !== undefined) {
        recentWakeHintBatches.delete(wakeHintBatchKey)
      }

      applyMemberSessionRouting(sessionID, latestMemberEntry)
      let promptResult: InternalPromptDispatchResult
      try {
        promptResult = await dispatchInternalPrompt({
          mode: "async",
          client: ctx.client,
          sessionID,
          source: "team-idle-wake-hint",
          settleMs: options?.idleSettleMs,
          postDispatchHoldMs: options?.postDispatchHoldMs,
          queueBehavior: "defer",
          input: {
            path: { id: sessionID },
            body: buildMemberPromptBody(latestMemberEntry, reservedBatch.promptText),
            query: { directory: ctx.directory },
          },
        })
      } catch (error) {
        await releaseReservedMailboxBatch(reservedBatch)
        throw error
      }
      const accepted = isInternalPromptDispatchAccepted(promptResult)
      const ambiguousAcceptedLike = promptResult.status === "failed"
        && isAmbiguousPostDispatchPromptFailure(promptResult)
      if (!accepted && !ambiguousAcceptedLike) {
        await releaseReservedMailboxBatch(reservedBatch)
        log("team idle wake hint skipped by promptAsync gate", {
          event: "team-mode-idle-wake-hint-gated",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          unreadCount: reservedBatch.messageIds.length,
          status: promptResult.status,
        })
        return
      }

      const pendingRecorded = await recordReservedMailboxBatchPending({
        teamRunId: latestRuntimeState.teamRunId,
        memberName: latestMemberEntry.name,
        expectedSessionID: latestMemberEntry.sessionId,
        sessionID,
        messageIds: reservedBatch.messageIds,
        config,
      }, reservedBatch)
      if (!pendingRecorded) return
      recentWakeHintBatches.set(wakeHintBatchKey, Date.now() + WAKE_HINT_DUPLICATE_SUPPRESSION_MS)

      log("team idle wake hint sent", {
        event: "team-mode-idle-wake-hint",
        teamRunId: latestRuntimeState.teamRunId,
        memberName: latestMemberEntry.name,
        sessionID,
        unreadCount: reservedBatch.messageIds.length,
        ackedCount: claimSettlement.ackedCount,
        requeuedCount: claimSettlement.requeuedCount,
        dispatchStatus: promptResult.status,
      })
    } catch (error) {
      log("team idle wake hint failed", {
        event: "team-mode-idle-wake-hint-error",
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

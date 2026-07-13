import type { TeamModeConfig } from "../../config/schema/team-mode"
import {
  findResolvedMemberSession,
  type ResolvedMemberSession,
} from "../../features/team-mode/member-session-resolution"
import {
  applyMemberSessionRouting,
  buildMemberPromptBody,
} from "../../features/team-mode/member-session-routing"
import { listUnreadMessages } from "../../features/team-mode/team-mailbox/inbox"
import { loadRuntimeState } from "../../features/team-mode/team-state-store/store"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { isAmbiguousPostDispatchPromptFailure } from "../../shared/prompt-failure-classifier"
import { log } from "../../shared/logger"
import { isSessionActive, settleAfterSessionIdle } from "../../shared/session-idle-settle"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../shared/prompt-async-gate"
import { settleIdleClaims, type IdleClaimSettlement } from "./pending-claim-settlement"

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

function getIdleSessionID(properties: unknown): string | undefined {
  return resolveSessionEventID(properties)
}

function buildWakeHint(unreadCount: number): string {
  return `You have ${unreadCount} new team messages. They will be injected on your next turn.`
}

function buildWakeHintBatchKey(sessionID: string, runtimeMember: ResolvedMemberSession, messageIds: string[]): string {
  return `${runtimeMember.teamRunId}:${runtimeMember.memberName}:${sessionID}:${messageIds.toSorted().join(",")}`
}

export function createTeamIdleWakeHint(ctx: TeamIdleWakeHintContext, config: TeamModeConfig, options?: TeamIdleWakeHintOptions): HookImpl {
  const recentWakeHintBatches = new Map<string, number>()

  return async ({ event }: HookInput): Promise<void> => {
    if (event.type !== "session.idle") return

    const sessionID = getIdleSessionID(event.properties)
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
      let claimSettlement: IdleClaimSettlement = {
        kind: "settled",
        ackedCount: 0,
        requeuedCount: 0,
        unresolvedCount: 0,
      }
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

      const unreadMessages = await listUnreadMessages(latestRuntimeState.teamRunId, latestMemberEntry.name, config)
      if (unreadMessages.length === 0) {
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

      if (typeof ctx.client.session.promptAsync !== "function") {
        log("team idle wake hint skipped without promptAsync", {
          event: "team-mode-idle-wake-hint-skipped",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          unreadCount: unreadMessages.length,
        })
        return
      }

      const now = Date.now()
      const wakeHintBatchKey = buildWakeHintBatchKey(
        sessionID,
        runtimeMember,
        unreadMessages.map((message) => message.messageId),
      )
      const suppressedUntil = recentWakeHintBatches.get(wakeHintBatchKey)
      if (suppressedUntil !== undefined && suppressedUntil > now) {
        log("team idle wake hint skipped for recently hinted unread batch", {
          event: "team-mode-idle-wake-hint-duplicate-suppressed",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          unreadCount: unreadMessages.length,
        })
        return
      }
      if (suppressedUntil !== undefined) {
        recentWakeHintBatches.delete(wakeHintBatchKey)
      }

      applyMemberSessionRouting(sessionID, latestMemberEntry)
      const promptResult = await dispatchInternalPrompt({
        mode: "async",
        client: ctx.client,
        sessionID,
        source: "team-idle-wake-hint",
        settleMs: options?.idleSettleMs,
        postDispatchHoldMs: options?.postDispatchHoldMs,
        queueBehavior: "defer",
        input: {
          path: { id: sessionID },
          body: buildMemberPromptBody(latestMemberEntry, buildWakeHint(unreadMessages.length)),
          query: { directory: ctx.directory },
        },
      })
      if (!isInternalPromptDispatchAccepted(promptResult)) {
        if (promptResult.status === "failed" && isAmbiguousPostDispatchPromptFailure(promptResult)) {
          recentWakeHintBatches.set(wakeHintBatchKey, Date.now() + WAKE_HINT_DUPLICATE_SUPPRESSION_MS)
        }
        log("team idle wake hint skipped by promptAsync gate", {
          event: "team-mode-idle-wake-hint-gated",
          teamRunId: latestRuntimeState.teamRunId,
          memberName: latestMemberEntry.name,
          sessionID,
          unreadCount: unreadMessages.length,
          status: promptResult.status,
        })
        return
      }
      recentWakeHintBatches.set(wakeHintBatchKey, Date.now() + WAKE_HINT_DUPLICATE_SUPPRESSION_MS)

      log("team idle wake hint sent", {
        event: "team-mode-idle-wake-hint",
        teamRunId: latestRuntimeState.teamRunId,
        memberName: latestMemberEntry.name,
        sessionID,
        unreadCount: unreadMessages.length,
        ackedCount: claimSettlement.ackedCount,
        requeuedCount: claimSettlement.requeuedCount,
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

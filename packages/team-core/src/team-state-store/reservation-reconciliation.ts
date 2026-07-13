import { isRecord } from "@oh-my-opencode/utils"
import type { TeamModeConfig } from "../config"
import { log } from "../logger"
import type { TeamSessionContext } from "../session-client"
import { withInboxConsumerLease } from "../team-mailbox/consumer-lease"
import {
  commitDeliveryReservation,
  discoverStaleDeliveryReservations,
  inspectDeliveryReservationState,
  releaseDeliveryReservation,
} from "../team-mailbox/reservation"
import type { RuntimeStateMember } from "../types"
import { transitionRuntimeState } from "./store"

const CONSUMER_LEASE_STALE_MS = 300_000

type ReservationReconciliationDeps = { readonly transitionRuntimeState?: typeof transitionRuntimeState }

function getMessagesData(response: unknown): unknown[] {
  if (isRecord(response) && Array.isArray(response.data)) {
    return response.data
  }

  return Array.isArray(response) ? response : []
}

function valueContainsMessageId(value: unknown, messageId: string): boolean {
  if (typeof value === "string") {
    return value.includes(messageId)
  }

  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsMessageId(entry, messageId))
  }

  if (isRecord(value)) {
    return Object.values(value).some((entry) => valueContainsMessageId(entry, messageId))
  }

  return false
}

async function findAcceptedReclaimedMessageIds(
  ctx: TeamSessionContext,
  member: RuntimeStateMember,
  messageIds: readonly string[],
): Promise<string[]> {
  if (messageIds.length === 0 || member.sessionId === undefined) {
    return []
  }

  try {
    const messagesLoader = ctx.client.session.messages
    if (messagesLoader === undefined) {
      return []
    }
    const response = await messagesLoader({ path: { id: member.sessionId } })
    const messages = getMessagesData(response)
    return messageIds.filter((messageId) => messages.some((message) => valueContainsMessageId(message, messageId)))
  } catch (historyError) {
    log("team mailbox reclaimed reservation history check failed", {
      event: "team-mailbox-reclaim-history-check-failed",
      member: member.name,
      sessionID: member.sessionId,
      error: historyError instanceof Error ? historyError.message : String(historyError),
    })
    return []
  }
}

export async function reconcileStaleReservationsForMember(
  ctx: TeamSessionContext,
  teamRunId: string,
  member: RuntimeStateMember,
  config: TeamModeConfig,
  staleReservationTtlMs: number,
  deps: ReservationReconciliationDeps = {},
): Promise<void> {
  await withInboxConsumerLease(
    teamRunId,
    member.name,
    config,
    async () => {
      const staleReservations = await discoverStaleDeliveryReservations({
        teamRunId,
        recipientName: member.name,
        config,
        staleTtlMs: staleReservationTtlMs,
      })
      const normalPendingMessageIds: string[] = []
      for (const messageId of member.pendingInjectedMessageIds) {
        const state = await inspectDeliveryReservationState(teamRunId, member.name, messageId, config)
        if (state === "inbox") normalPendingMessageIds.push(messageId)
      }
      if (staleReservations.length === 0 && normalPendingMessageIds.length === 0) return

      const messageIds = staleReservations.map(({ messageId }) => messageId)
      const acceptedMessageIds = new Set(await findAcceptedReclaimedMessageIds(ctx, member, messageIds))
      const recoveredMessageIds = new Set([...messageIds, ...normalPendingMessageIds])
      let stateWasUpdated = false
      await (deps.transitionRuntimeState ?? transitionRuntimeState)(
        teamRunId,
        (runtimeState) => {
          const currentMember = runtimeState.members.find(({ name }) => name === member.name)
          if (currentMember === undefined || currentMember.sessionId !== member.sessionId) return runtimeState
          stateWasUpdated = true
          return {
            ...runtimeState,
            members: runtimeState.members.map((candidate) => {
              if (candidate.name !== member.name) return candidate
              const { lastInjectedTurnMarker: _turnMarker, ...memberWithoutTurnMarker } = candidate
              return {
                ...memberWithoutTurnMarker,
                pendingInjectedMessageIds: candidate.pendingInjectedMessageIds.filter(
                  (messageId) => !recoveredMessageIds.has(messageId),
                ),
              }
            }),
          }
        },
        config,
      )
      if (!stateWasUpdated) return

      for (const { messageId, reservation } of staleReservations) {
        if (acceptedMessageIds.has(messageId)) await commitDeliveryReservation(reservation)
        else await releaseDeliveryReservation(reservation)
      }
    },
    { staleAfterMs: CONSUMER_LEASE_STALE_MS },
  )
}

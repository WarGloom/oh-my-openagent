import type { TeamModeConfig } from "../../config/schema/team-mode"
import { withInboxConsumerLease } from "../../features/team-mode/team-mailbox"
import { listUnreadMessages } from "../../features/team-mode/team-mailbox/inbox"
import { buildEnvelope } from "../../features/team-mode/team-mailbox/poll"
import {
  releaseDeliveryReservation,
  reserveMessageForDelivery,
  type DeliveryReservation,
} from "../../features/team-mode/team-mailbox/reservation"
import { transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import { log } from "../../shared/logger"

type MailboxOwner = {
  readonly teamRunId: string
  readonly memberName: string
}

type MailboxBatchIdentity = MailboxOwner & {
  readonly config: TeamModeConfig
}

type PendingMailboxBatchInput = MailboxBatchIdentity & {
  readonly expectedSessionID: string | undefined
  readonly messageIds: readonly string[]
}

type ReservedMailboxDelivery = {
  readonly messageId: string
  readonly reservation: DeliveryReservation
}

export type ReservedMailboxBatch = {
  readonly teamRunId: string
  readonly memberName: string
  readonly messageIds: readonly string[]
  readonly promptText: string
  readonly reservations: readonly ReservedMailboxDelivery[]
}

const CURRENT_TURN_INSTRUCTION =
  "Process every <peer_message> below now as payload for this current turn. Do not defer these messages to a future turn."

async function releaseReservations(input: MailboxOwner, reservations: readonly ReservedMailboxDelivery[]): Promise<void> {
  const releases = await Promise.allSettled(
    reservations.map(async ({ reservation }) => releaseDeliveryReservation(reservation)),
  )
  for (const [index, release] of releases.entries()) {
    if (release.status === "fulfilled") continue
    const delivery = reservations[index]
    if (delivery === undefined) continue
    log("team mailbox reservation release failed", {
      event: "team-mode-mailbox-reservation-release-failed",
      teamRunId: input.teamRunId,
      memberName: input.memberName,
      messageId: delivery.messageId,
      error: release.reason instanceof Error ? release.reason.message : String(release.reason),
    })
  }
}

export async function reserveUnreadMailboxBatch(
  input: MailboxBatchIdentity,
): Promise<ReservedMailboxBatch | null> {
  return withInboxConsumerLease(
    input.teamRunId,
    input.memberName,
    input.config,
    async () => {
      const unreadMessages = await listUnreadMessages(input.teamRunId, input.memberName, input.config)
      if (unreadMessages.length === 0) return null

      const reservations: ReservedMailboxDelivery[] = []
      try {
        for (const message of unreadMessages) {
          const reservation = await reserveMessageForDelivery(
            input.teamRunId,
            input.memberName,
            message.messageId,
            input.config,
          )
          if (reservation === null) {
            await releaseReservations(input, reservations)
            return null
          }
          reservations.push({ messageId: message.messageId, reservation })
        }
      } catch (error) {
        await releaseReservations(input, reservations)
        throw error
      }

      return {
        teamRunId: input.teamRunId,
        memberName: input.memberName,
        messageIds: unreadMessages.map((message) => message.messageId),
        promptText: [CURRENT_TURN_INSTRUCTION, ...unreadMessages.map(buildEnvelope)].join("\n\n"),
        reservations,
      }
    },
    { staleAfterMs: 0 },
  )
}

export async function releaseReservedMailboxBatch(batch: ReservedMailboxBatch): Promise<void> {
  await releaseReservations(batch, batch.reservations)
}

export async function markReservedMailboxBatchPending(input: PendingMailboxBatchInput): Promise<boolean> {
  let committed = false
  await transitionRuntimeState(input.teamRunId, (runtimeState) => {
    const runtimeMember = runtimeState.members.find((member) => member.name === input.memberName)
    if (runtimeMember === undefined || runtimeMember.sessionId !== input.expectedSessionID) {
      return runtimeState
    }
    committed = true
    return {
      ...runtimeState,
      members: runtimeState.members.map((member) => member.name === input.memberName
        ? {
            ...member,
            pendingInjectedMessageIds: Array.from(new Set([
              ...member.pendingInjectedMessageIds,
              ...input.messageIds,
            ])),
          }
        : member),
    }
  }, input.config)
  return committed
}

type PendingMailboxBatchAdmissionInput = PendingMailboxBatchInput & { readonly sessionID: string }

export async function recordReservedMailboxBatchPending(
  input: PendingMailboxBatchAdmissionInput,
  batch: ReservedMailboxBatch,
): Promise<boolean> {
  try {
    const recorded = await markReservedMailboxBatchPending(input)
    if (recorded) return true
    await releaseReservedMailboxBatch(batch)
    log("team idle wake released after stale session replacement", {
      event: "team-mode-idle-wake-hint-stale-session",
      teamRunId: input.teamRunId,
      memberName: input.memberName,
      sessionID: input.sessionID,
      unreadCount: input.messageIds.length,
    })
    return false
  } catch (error) {
    await releaseReservedMailboxBatch(batch)
    log("team idle wake pending state failed; released batch", {
      event: "team-mode-idle-wake-hint-pending-state-failed",
      teamRunId: input.teamRunId,
      memberName: input.memberName,
      sessionID: input.sessionID,
      messageIds: input.messageIds,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

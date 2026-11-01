import { createHash } from "node:crypto"
import type { TeamModeConfig } from "../config"
import { log } from "../logger"
import { transitionRuntimeStateAsync } from "../team-state-store/store"
import { withInboxConsumerLease } from "./consumer-lease"
import { listUnreadMessages } from "./inbox"
import { buildEnvelope } from "./poll"
import { releaseDeliveryReservation, reserveMessageForDelivery, type DeliveryReservation } from "./reservation"

type DeliveryInput = {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly config: TeamModeConfig
  readonly admit: (input: { readonly sessionID: string; readonly id: string; readonly text: string }) => Promise<void>
}

export async function deliverMailboxV2(input: DeliveryInput): Promise<readonly string[]> {
  return withInboxConsumerLease(
    input.teamRunId,
    input.memberName,
    input.config,
    async () => {
      let delivered: readonly string[] = []
      const reservations: DeliveryReservation[] = []
      try {
        await transitionRuntimeStateAsync(
          input.teamRunId,
          async (state) => {
            const member = state.members.find((candidate) => candidate.name === input.memberName)
            if (!member?.sessionId || member.sessionId !== input.sessionID || member.removal) return state
            const pending = new Set(member.pendingInjectedMessageIds)
            const messages = (await listUnreadMessages(input.teamRunId, input.memberName, input.config)).filter(
              (message) => !pending.has(message.messageId),
            )
            if (messages.length === 0) return state
            const messageIds = messages.map((message) => message.messageId)
            for (const message of messages) {
              const reservation = await reserveMessageForDelivery(
                input.teamRunId,
                input.memberName,
                message.messageId,
                input.config,
              )
              if (reservation === null) throw new Error(`mailbox message missing: ${message.messageId}`)
              reservations.push(reservation)
              const startedAt = Date.now()
              const warning = setTimeout(() => {
                log("[team-mailbox] slow V2 admission", {
                  teamRunId: input.teamRunId,
                  memberName: input.memberName,
                  messageIds: [message.messageId],
                  elapsedMs: Date.now() - startedAt,
                })
              }, 5_000)
              try {
                const digest = createHash("sha256")
                  .update(JSON.stringify([member.sessionId, message.messageId]))
                  .digest("hex")
                await input.admit({ sessionID: member.sessionId, id: `msg_${digest}`, text: buildEnvelope(message) })
              } finally {
                clearTimeout(warning)
              }
            }
            delivered = messageIds
            return {
              ...state,
              members: state.members.map((candidate) =>
                candidate.name === input.memberName
                  ? {
                      ...candidate,
                      pendingInjectedMessageIds: [...new Set([...candidate.pendingInjectedMessageIds, ...messageIds])],
                    }
                  : candidate,
              ),
            }
          },
          input.config,
        )
      } catch (error) {
        const releases = await Promise.allSettled(reservations.map(releaseDeliveryReservation))
        const failures = releases.filter((result) => result.status === "rejected").map((result) => result.reason)
        if (failures.length > 0)
          throw new AggregateError([error, ...failures], "mailbox delivery and reservation release failed")
        throw error
      }
      return delivered
    },
    { staleAfterMs: 0 },
  )
}

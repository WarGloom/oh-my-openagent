import { createHash } from "node:crypto"
import { DEFAULT_LEAD_FYI_WAKE_DELAY_SECONDS, type TeamModeConfig } from "../config"
import { log } from "../logger"
import { transitionRuntimeStateAsync } from "../team-state-store/store"
import { ackMessages } from "./ack"
import { withInboxConsumerLease } from "./consumer-lease"
import { listUnreadMessages } from "./inbox"
import { selectMailboxMember, selectUnreadMailboxMessages } from "./eligibility"
import { buildEnvelope } from "./poll"

export type V2MailboxAdmission = {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly wakeAfterMs?: number
}

export type V2MailboxDelivery = { readonly admitted: readonly string[]; readonly deferred: boolean }

type DeliveryInput = {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly config: TeamModeConfig
  readonly admit: (input: V2MailboxAdmission) => Promise<void | false>
}

export async function deliverMailboxV2(input: DeliveryInput): Promise<V2MailboxDelivery> {
  return withInboxConsumerLease(
    input.teamRunId,
    input.memberName,
    input.config,
    async () => {
      const admitted: string[] = []
      let deferred = false
      await transitionRuntimeStateAsync(
        input.teamRunId,
        async (state) => {
          const selection = selectMailboxMember(state, input.memberName, input.sessionID)
          if (selection.kind !== "matched" || selection.member.removal) return state
          const member = selection.member
          if (member.status === "completed" || member.status === "shutdown_approved") return state
          const messages = selectUnreadMailboxMessages(
            member,
            await listUnreadMessages(input.teamRunId, input.memberName, input.config),
          )
          for (const message of messages) {
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
                .update(JSON.stringify([input.sessionID, message.messageId]))
                .digest("hex")
              const deferWake = member.agentType === "leader" && message.needsLeadAction === false &&
                (message.kind === "message" || message.kind === "announcement")
              const outcome = await input.admit({
                sessionID: input.sessionID,
                id: `msg_${digest}`,
                text: buildEnvelope(message),
                ...(deferWake ? {
                  wakeAfterMs: (input.config.lead_fyi_wake_delay_seconds ?? DEFAULT_LEAD_FYI_WAKE_DELAY_SECONDS) * 1_000,
                } : {}),
              })
              if (outcome === false) {
                deferred = true
                break
              }
              // The host owns the durable prompt now. Do not infer delivery from compacted history.
              await ackMessages(input.teamRunId, input.memberName, [message.messageId], input.config)
              admitted.push(message.messageId)
            } finally {
              clearTimeout(warning)
            }
          }
          return state
        },
        input.config,
      )
      return { admitted, deferred }
    },
    { staleAfterMs: 0 },
  )
}

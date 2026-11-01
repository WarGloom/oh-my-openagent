import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { buildEnvelope } from "@oh-my-opencode/team-core/team-mailbox/poll"
import { reserveMessageForDelivery } from "@oh-my-opencode/team-core/team-mailbox/reservation"
import type { Message } from "@oh-my-opencode/team-core/types"
import type { LiveDeliveryClient } from "./messaging-live-delivery-client"
import { releaseReservationSafely } from "./messaging-live-delivery-reservation"
import { deliverLiveToRecipient } from "./messaging-live-delivery-recipient"
import { loadRuntimeStateForLiveDelivery } from "./messaging-live-delivery-state"
import type { TeamSendMessageToolDeps } from "./messaging-runtime"
import { isTeamSessionDenied } from "../team-session-registry"
import { log } from "../../../shared/logger"

export type { LiveDeliveryClient } from "./messaging-live-delivery-client"

export async function deliverLive(
  client: LiveDeliveryClient,
  message: Message,
  teamRunId: string,
  deliveredTo: readonly string[],
  config: TeamModeConfig,
  directory: string,
  deps: TeamSendMessageToolDeps,
): Promise<void> {
  const runtimeState = await loadRuntimeStateForLiveDelivery(teamRunId, deliveredTo, message.messageId, config, deps)
  if (!runtimeState) return

  const envelope = buildEnvelope(message)

  for (const recipientName of deliveredTo) {
    if (client.session.nativeTeamMailbox) {
      const member = runtimeState.members.find((entry) => entry.name === recipientName)
      if (!member?.sessionId || member.removal || member.status === "completed" || member.status === "shutdown_approved" || isTeamSessionDenied(member.sessionId, config)) continue
      try {
        await client.session.nativeTeamMailbox({ teamRunId, memberName: recipientName, sessionID: member.sessionId, config })
      } catch (error) {
        log("[team-mailbox] V2 live delivery failed", { teamRunId, recipientName, error })
      }
      continue
    }
    const reservation = await reserveMessageForDelivery(teamRunId, recipientName, message.messageId, config)
    if (reservation === null) continue

    const recipientMember = runtimeState.members.find((entry) => entry.name === recipientName)
    if (!recipientMember) {
      await releaseReservationSafely(reservation, {
        teamRunId,
        recipient: recipientName,
        messageId: message.messageId,
      })
      continue
    }

    await deliverLiveToRecipient({
      client,
      message,
      envelope,
      teamRunId,
      recipientName,
      recipientMember,
      reservation,
      config,
      directory,
      settleMs: deps.liveDeliverySettleMs,
      dispatchTiming: deps.dispatchTiming,
    })
  }
}

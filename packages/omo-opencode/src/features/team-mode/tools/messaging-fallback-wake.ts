import type { TeamModeConfig } from "../../../config/schema/team-mode"
import {
  dispatchInternalPrompt,
  isInternalPromptDispatchAccepted,
} from "../../../hooks/shared/prompt-async-gate"
import { isPreSendConnectionFailure } from "../../../shared/live-server-route"
import { log } from "../../../shared/logger"
import { isAmbiguousPostDispatchPromptFailure } from "../../../shared/prompt-failure-classifier"
import {
  reserveUnreadMailboxBatch,
  releaseReservedMailboxBatch,
  recordReservedMailboxBatchPending,
  type ReservedMailboxBatch,
} from "../../../hooks/team-session-events/reserved-mailbox-batch"
import { buildMemberPromptBody } from "../member-session-routing"
import { readUnreadMessageById } from "@oh-my-opencode/team-core/team-mailbox/inbox"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"
import type { LiveDeliveryClient } from "./messaging-live-delivery-client"
import type { TeamSendMessageDispatchTiming } from "./messaging-runtime"

type RuntimeMember = RuntimeState["members"][number]

export async function enqueueFallbackMailboxWake(input: {
  readonly client: LiveDeliveryClient
  readonly recipientMember: RuntimeMember
  readonly recipientSessionId: string
  readonly directory: string
  readonly teamRunId: string
  readonly recipientName: string
  readonly messageId: string
  readonly config: TeamModeConfig
  readonly dispatchTiming?: TeamSendMessageDispatchTiming
}): Promise<void> {
  let batch: ReservedMailboxBatch | null = null
  let admissionGeneration = 0
  const promptInput = {
    path: { id: input.recipientSessionId },
    body: buildMemberPromptBody(input.recipientMember, ""),
    query: { directory: input.recipientMember.worktreePath ?? input.directory },
  }
  const promptResult = await dispatchInternalPrompt({
    mode: "async",
    client: input.client,
    sessionID: input.recipientSessionId,
    source: "team-live-delivery-fallback",
    dedupeKey: `team-live-delivery-fallback:${input.messageId}`,
    queueBehavior: "enqueue",
    durableRetry: true,
    settleMs: input.dispatchTiming?.fallbackWakeSettleMs,
    postDispatchHoldMs: input.dispatchTiming?.postDispatchHoldMs,
    queueRetryMs: input.dispatchTiming?.queueRetryMs,
    shouldDispatch: async () => {
      const generation = admissionGeneration
      if (!await shouldDispatchFallbackMailboxWake(input)) return false
      const reserved = await reserveUnreadMailboxBatch({
        teamRunId: input.teamRunId,
        memberName: input.recipientName,
        config: input.config,
      })
      if (!reserved) return false
      let handedOff = false
      try {
        const stillEligible = await shouldDispatchFallbackMailboxWake(input, false)
        if (generation !== admissionGeneration || !stillEligible) return false
        promptInput.body = buildMemberPromptBody(input.recipientMember, reserved.promptText)
        batch = reserved
        handedOff = true
        return true
      } finally {
        if (!handedOff) await releaseReservedMailboxBatch(reserved)
      }
    },
    onDispatchResult: async (result) => {
      admissionGeneration += 1
      const reserved = batch
      if (!reserved) return
      try {
        if (result.status === "dispatched" || (result.status === "failed" && isAmbiguousPostDispatchPromptFailure(result))) {
          await recordReservedMailboxBatchPending({
            teamRunId: input.teamRunId,
            memberName: input.recipientName,
            expectedSessionID: input.recipientSessionId,
            sessionID: input.recipientSessionId,
            messageIds: reserved.messageIds,
            config: input.config,
          }, reserved)
        } else {
          await releaseReservedMailboxBatch(reserved)
        }
      } catch (error) {
        await releaseReservedMailboxBatch(reserved)
        throw error
      } finally {
        if (batch === reserved) batch = null
      }
    },
    retryDispatchFailure: isPreSendConnectionFailure,
    input: promptInput,
  })
  if (isInternalPromptDispatchAccepted(promptResult)) return

  log("[team-mailbox] fallback mailbox wake was not accepted", {
    status: promptResult.status,
    teamRunId: input.teamRunId,
    recipient: input.recipientName,
    recipientSessionId: input.recipientSessionId,
    messageId: input.messageId,
  })
}

async function shouldDispatchFallbackMailboxWake(input: {
  readonly teamRunId: string
  readonly recipientName: string
  readonly recipientSessionId: string
  readonly messageId: string
  readonly config: TeamModeConfig
}, requireUnread = true): Promise<boolean> {
  try {
    const runtimeState = await loadRuntimeState(input.teamRunId, input.config)
    const recipient = runtimeState.members.find((member) => member.name === input.recipientName)
    const recipientIsActive = recipient?.status === "running" || recipient?.status === "idle"
    if (
      runtimeState.status !== "active"
      || recipient?.sessionId !== input.recipientSessionId
      || !recipientIsActive
    ) {
      return false
    }

    if (recipient.pendingInjectedMessageIds.includes(input.messageId)) {
      return false
    }

    if (!requireUnread) return true
    const unread = await readUnreadMessageById(
      input.teamRunId,
      input.recipientName,
      input.messageId,
      input.config,
    )
    return unread !== undefined
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      log("[team-mailbox] fallback mailbox wake cancelled because team state no longer exists", {
        teamRunId: input.teamRunId,
        recipient: input.recipientName,
        recipientSessionId: input.recipientSessionId,
        messageId: input.messageId,
      })
      return false
    }

    log("[team-mailbox] fallback mailbox wake revalidation failed, retaining queued wake", {
      teamRunId: input.teamRunId,
      recipient: input.recipientName,
      recipientSessionId: input.recipientSessionId,
      messageId: input.messageId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

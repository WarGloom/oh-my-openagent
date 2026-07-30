import { log } from "../../shared"
import { cloneParentWakeForReplyRetry, type PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"
import type { ParentWakeSessionInspector } from "./parent-wake-session-inspector"

const MAX_NO_ASSISTANT_OUTPUT_RETRIES = 1

type ParentWakeWindowRecoveryInput = {
  readonly sessionID: string
  readonly wake: PendingParentWake
  readonly dispatchedTracker: ParentWakeDispatchedTracker
  readonly sessionInspector: ParentWakeSessionInspector
  readonly requeueWake: (wake: PendingParentWake) => void
  readonly scheduleFlush: () => void
}

export async function handleDispatchedParentWakeWindowElapsed(
  input: ParentWakeWindowRecoveryInput,
): Promise<void> {
  const initialWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!currentWakeMatches(initialWake, input.wake)) {
    return
  }

  const outputInspection = await input.sessionInspector.hasAssistantOrToolOutputAfterDispatchedWake(
    input.sessionID,
    input.wake,
  )
  const currentWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!currentWakeMatches(currentWake, input.wake)) {
    return
  }

  if (outputInspection === "unknown") {
    input.dispatchedTracker.refreshWakeTimer(input.sessionID)
    log("[background-agent] Kept dispatched parent wake awaiting readable parent history:", {
      sessionID: input.sessionID,
    })
    return
  }

  if (outputInspection === "output") {
    input.dispatchedTracker.clearWake(input.sessionID)
    if (currentWake.replyRequiredNoReplyDispatch === true) {
      input.requeueWake(cloneParentWakeForReplyRetry(currentWake))
      input.scheduleFlush()
      log("[background-agent] Requeued reply-required parent wake after noReply admission window observed assistant output:", {
        sessionID: input.sessionID,
      })
      return
    }
    log("[background-agent] Cleared dispatched parent wake after observing assistant output:", {
      sessionID: input.sessionID,
    })
    return
  }

  if (currentWake.replyRequiredNoReplyDispatch === true) {
    input.dispatchedTracker.clearWake(input.sessionID)
    input.sessionInspector.clearActivity(input.sessionID)
    input.requeueWake(cloneParentWakeForReplyRetry(currentWake))
    input.scheduleFlush()
    log("[background-agent] Requeued reply-required parent wake after noReply admission window produced no assistant output:", {
      sessionID: input.sessionID,
    })
    return
  }

  const retryCount = currentWake.noAssistantOutputRetryCount ?? 0
  if (retryCount >= MAX_NO_ASSISTANT_OUTPUT_RETRIES) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Stopped retrying parent wake after repeated no-output dispatch:", {
      sessionID: input.sessionID,
      retryCount,
    })
    return
  }

  input.dispatchedTracker.clearWake(input.sessionID)
  currentWake.noAssistantOutputRetryCount = retryCount + 1
  input.requeueWake(currentWake)
  input.scheduleFlush()
  log("[background-agent] Requeued dispatched parent wake after no assistant output:", {
    sessionID: input.sessionID,
    retryCount: currentWake.noAssistantOutputRetryCount,
  })
}

export function logParentWakeWindowRecoveryError(sessionID: string, error: unknown): void {
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  log("[background-agent] Failed to inspect dispatched parent wake after recovery window:", {
    sessionID,
    error: errorText,
  })
}

export function rescheduleParentWakeWindowRecoveryAfterError(
  sessionID: string,
  wake: PendingParentWake,
  dispatchedTracker: ParentWakeDispatchedTracker,
): void {
  const currentWake = dispatchedTracker.getWake(sessionID)
  if (!currentWake || currentWake.dispatchedAt !== wake.dispatchedAt) {
    return
  }
  dispatchedTracker.refreshWakeTimer(sessionID)
}

function currentWakeMatches(
  currentWake: PendingParentWake | undefined,
  expectedWake: PendingParentWake,
): currentWake is PendingParentWake {
  return currentWake?.dispatchedAt !== undefined
    && currentWake.dispatchedAt === expectedWake.dispatchedAt
}

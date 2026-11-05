import type { PluginInput } from "@opencode-ai/plugin"

import type { BackgroundManager } from "../../features/background-agent"
import { log } from "../../shared/logger"

import { COUNTDOWN_SECONDS, HOOK_NAME } from "./constants"
import type { ResolvedMessageInfo } from "./types"
import type { SessionStateStore } from "./session-state"
import { injectContinuation } from "./continuation-injection"

export function startCountdown(args: {
  ctx: PluginInput
  sessionID: string
  incompleteCount: number
  total: number
  resolvedInfo?: ResolvedMessageInfo
  backgroundManager?: BackgroundManager
  skipAgents: string[]
  sessionStateStore: SessionStateStore
  isContinuationStopped?: (sessionID: string) => boolean
}): void {
  const {
    ctx,
    sessionID,
    incompleteCount,
    resolvedInfo,
    backgroundManager,
    skipAgents,
    sessionStateStore,
    isContinuationStopped,
  } = args

  const state = sessionStateStore.getState(sessionID)
  sessionStateStore.cancelCountdown(sessionID)

  state.countdownStartedAt = Date.now()

  state.countdownTimer = setTimeout(() => {
    sessionStateStore.cancelCountdown(sessionID)
    injectContinuation({
      ctx,
      sessionID,
      backgroundManager,
      skipAgents,
      resolvedInfo,
      sessionStateStore,
      isContinuationStopped,
    })
  }, COUNTDOWN_SECONDS * 1000)

  log(`[${HOOK_NAME}] Countdown started`, {
    sessionID,
    seconds: COUNTDOWN_SECONDS,
    incompleteCount,
  })
}

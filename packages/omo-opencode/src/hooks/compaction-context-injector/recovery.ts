import {
  resolveRegisteredAgentName,
  updateSessionAgent,
} from "../../features/claude-code-session-state"
import {
  getCompactionAgentConfigCheckpoint,
} from "../../shared/compaction-agent-config-checkpoint"
import {
  createInternalAgentContinuationTextPart,
  withInternalNoReplyMarker,
} from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"
import { isAmbiguousPostDispatchPromptFailure } from "../../shared/prompt-failure-classifier"
import { clearSessionModel, setSessionModel } from "../../shared/session-model-state"
import { deleteSessionTools, setSessionTools } from "../../shared/session-tools-store"
import {
  createExpectedRecoveryPromptConfig,
  type RecoveryPromptConfig,
  isPromptConfigRecovered,
} from "./recovery-prompt-config"
import { validateCheckpointModel } from "./validated-model"
import {
  resolveLatestSessionPromptConfig,
  resolveSessionPromptConfig,
} from "./session-prompt-config-resolver"
import { AGENT_RECOVERY_PROMPT, NO_TEXT_TAIL_THRESHOLD, RECOVERY_COOLDOWN_MS, RECENT_COMPACTION_WINDOW_MS, MAX_CONSECUTIVE_RECOVERY_FAILURES } from "./constants"
import type { CompactionContextClient } from "./types"
import type { TailMonitorState } from "./tail-monitor"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted, releasePromptAsyncReservation } from "../shared/prompt-async-gate"

export function syncRecoveredSessionPromptState(
  sessionID: string,
  promptConfig: Pick<RecoveryPromptConfig, "agent"> & {
    model?: RecoveryPromptConfig["model"]
    tools?: RecoveryPromptConfig["tools"]
  },
): void {
  updateSessionAgent(sessionID, promptConfig.agent)

  if (promptConfig.model) {
    setSessionModel(sessionID, promptConfig.model, promptConfig.agent)
  } else {
    clearSessionModel(sessionID)
  }

  if (promptConfig.tools) {
    setSessionTools(sessionID, promptConfig.tools)
  } else {
    deleteSessionTools(sessionID)
  }
}

export function createRecoveryLogic(
  ctx: CompactionContextClient | undefined,
  getTailState: (sessionID: string) => TailMonitorState,
) {
  const isRecentSuccessfulRecoveryAfterCompaction = (
    tailState: TailMonitorState,
    now: number,
  ): boolean => {
    if (!tailState.lastRecoveryAt || tailState.lastCompactedAt === undefined) {
      return false
    }

    return (
      tailState.lastRecoveryAt >= tailState.lastCompactedAt &&
      now - tailState.lastRecoveryAt < RECENT_COMPACTION_WINDOW_MS
    )
  }

  const recoverCheckpointedAgentConfig = async (
    sessionID: string,
    reason: "compaction.autocontinue" | "session.compacted" | "no-text-tail",
  ): Promise<boolean> => {
    if (!ctx) {
      return false
    }

    const checkpoint = getCompactionAgentConfigCheckpoint(sessionID)
    if (!checkpoint?.agent) {
      return false
    }

    const tailState = getTailState(sessionID)
    const now = Date.now()

    if (isRecentSuccessfulRecoveryAfterCompaction(tailState, now)) {
      return false
    }

    if (
      tailState.lastRecoveryAttemptAt &&
      now - tailState.lastRecoveryAttemptAt < RECOVERY_COOLDOWN_MS
    ) {
      return false
    }

    if (tailState.consecutiveRecoveryFailures >= MAX_CONSECUTIVE_RECOVERY_FAILURES) {
      log(`[compaction-context-injector] Skipping recovery after ${tailState.consecutiveRecoveryFailures} consecutive failures`, {
        sessionID,
        reason,
      })
      return false
    }

    const currentPromptConfig = await resolveSessionPromptConfig(ctx, sessionID)
    const validatedCheckpointModel = validateCheckpointModel(
      checkpoint.model,
      currentPromptConfig.model,
    )
    const { model: checkpointModel, ...checkpointWithoutModel } = checkpoint
    const checkpointWithAgent = {
      ...checkpointWithoutModel,
      agent: checkpoint.agent,
      ...(validatedCheckpointModel ? { model: validatedCheckpointModel } : {}),
    }

    if (checkpointModel && !validatedCheckpointModel) {
      log(`[compaction-context-injector] Ignoring checkpoint model that disagrees with current prompt config`, {
        sessionID,
        checkpointModel,
        currentModel: currentPromptConfig.model,
      })
    }

    const expectedPromptConfig = createExpectedRecoveryPromptConfig(
      checkpointWithAgent,
      currentPromptConfig,
    )
    const launchAgent = resolveRegisteredAgentName(expectedPromptConfig.agent)
    const model = expectedPromptConfig.model
    const tools = expectedPromptConfig.tools

    if (reason === "compaction.autocontinue" || reason === "session.compacted") {
      const latestPromptConfig = await resolveLatestSessionPromptConfig(ctx, sessionID)
      if (isPromptConfigRecovered(latestPromptConfig, expectedPromptConfig)) {
        return false
      }
    }

    const input = {
      path: { id: sessionID },
      body: {
        noReply: true,
        agent: launchAgent ?? expectedPromptConfig.agent,
        ...(model ? { model } : {}),
        ...(tools ? { tools } : {}),
        parts: [withInternalNoReplyMarker(createInternalAgentContinuationTextPart(AGENT_RECOVERY_PROMPT))],
      },
      query: { directory: ctx.directory },
    }

    try {
      const promptResult = await dispatchInternalPrompt({
        mode: "async",
        client: ctx.client,
        sessionID,
        source: "compaction-context-injector",
        queueBehavior: "defer",
        input,
      })
      if (promptResult.status === "reserved" || promptResult.status === "active") {
        await dispatchInternalPrompt({
          mode: "async",
          client: ctx.client,
          sessionID,
          source: "compaction-context-injector",
          queueBehavior: "enqueue",
          input,
        })
        tailState.lastRecoveryAttemptAt = now
        log(`[compaction-context-injector] Recovery queued after promptAsync gate`, {
          sessionID,
          reason,
          status: promptResult.status,
        })
        return false
      }

      tailState.lastRecoveryAttemptAt = now

      if (!isInternalPromptDispatchAccepted(promptResult)) {
        if (promptResult.status === "failed" && isAmbiguousPostDispatchPromptFailure(promptResult)) {
          tailState.lastRecoveryAt = now
        }
        log(`[compaction-context-injector] Recovery skipped by promptAsync gate`, {
          sessionID,
          reason,
          status: promptResult.status,
        })
        return false
      }
      tailState.lastRecoveryAt = now

      const recoveredPromptConfig = await resolveLatestSessionPromptConfig(ctx, sessionID)
      if (!isPromptConfigRecovered(recoveredPromptConfig, expectedPromptConfig)) {
        tailState.consecutiveRecoveryFailures++
        log(`[compaction-context-injector] Re-injected agent config but recovery is still incomplete`, {
          sessionID,
          reason,
          agent: expectedPromptConfig.agent,
          model,
          hasTools: !!tools,
          recoveredPromptConfig,
          consecutiveFailures: tailState.consecutiveRecoveryFailures,
        })
        return false
      }

      tailState.consecutiveRecoveryFailures = 0
      syncRecoveredSessionPromptState(sessionID, expectedPromptConfig)
      releasePromptAsyncReservation(sessionID, "compaction-context-injector")

      tailState.consecutiveNoTextMessages = 0

      log(`[compaction-context-injector] Re-injected checkpointed agent config`, {
        sessionID,
        reason,
        agent: expectedPromptConfig.agent,
        model,
      })

      return true
    } catch (error) {
      log(`[compaction-context-injector] Failed to re-inject checkpointed agent config`, {
        sessionID,
        reason,
        error: String(error),
      })
      return false
    }
  }

  const maybeWarnAboutNoTextTail = async (sessionID: string): Promise<void> => {
    const tailState = getTailState(sessionID)
    if (tailState.consecutiveNoTextMessages < NO_TEXT_TAIL_THRESHOLD) {
      return
    }

    const recentlyCompacted =
      tailState.lastCompactedAt !== undefined &&
      Date.now() - tailState.lastCompactedAt < RECENT_COMPACTION_WINDOW_MS

    log(`[compaction-context-injector] Detected consecutive assistant messages with no text`, {
      sessionID,
      consecutiveNoTextMessages: tailState.consecutiveNoTextMessages,
      recentlyCompacted,
    })

    if (recentlyCompacted) {
      await recoverCheckpointedAgentConfig(sessionID, "no-text-tail")
    }
  }

  return {
    recoverCheckpointedAgentConfig,
    maybeWarnAboutNoTextTail,
  }
}

import { isSyntheticOrInternalUserMessage, log } from "../../shared"
import {
  latestAssistantTurnBlocksInternalPrompt,
  latestAssistantTurnHasUnansweredQuestion,
} from "../../shared/prompt-async-gate/pending-tool-turn"
import {
  latestAssistantTurnHasFreshToolActivity,
  latestAssistantTurnHasStaleUnknownSubstantiveOutput,
  latestAssistantTurnHasToolBlock,
  latestAssistantTurnIsCompletedEmptyNoProgress,
} from "./parent-wake-history-state"
import {
  isBackgroundTaskProgressNotification,
  isFinalBackgroundTaskNotification,
  type PendingParentWake,
} from "./parent-wake-dedupe"
import {
  getParentWakeMessageCreatedAt,
  getParentWakeMessagePartActivityAt,
} from "./parent-wake-message-activity"
import type { ParentWakeSessionMessage } from "./parent-wake-session-message"

export type ToolWaitDeferralDecision = {
  readonly defer: boolean
  readonly skipPromptGateToolStateCheck: boolean
}

export function parentWakeUserMessageIsInProgress(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly windowMs: number
  readonly now?: number
}): boolean {
  if (input.windowMs <= 0) {
    return false
  }
  if (!input.messages) {
    return true
  }
  const now = input.now ?? Date.now()
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]
    if (!message) {
      continue
    }
    const role = getParentWakeMessageRole(message)
    if (role === "user") {
      if (isSyntheticOrInternalUserMessage(message)) {
        continue
      }
      const createdAt = getParentWakeMessageCreatedAt(message)
      if (createdAt === undefined) {
        return false
      }
      return now - createdAt <= input.windowMs
    }
    if (role === "assistant" || role === "tool") {
      return false
    }
  }
  return false
}

export function getParentWakeSessionHistoryDeferralDecision(input: {
  readonly sessionID: string
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly toolCallDeferMaxMs: number
  readonly now?: number
}): ToolWaitDeferralDecision {
  if (!input.messages) {
    log("[background-agent] Deferred parent wake because parent messages could not be inspected:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false }
  }
  const messages = [...input.messages]
  const wakeIsTerminalBackgroundTaskFinal = input.wake.notifications.some(isFinalBackgroundTaskNotification)
  let strippedOwnAdmittedDeposit = false
  let strippedOwnAdmittedTailCreatedAt: number | undefined
  if (input.wake.noReplyAdmittedAt !== undefined) {
    while (messages.length > 0) {
      const last = messages[messages.length - 1]
      if (
        !last
        || getParentWakeMessageRole(last) !== "user"
        || !isSyntheticOrInternalUserMessage(last)
        || !parentWakeMessageIsInternalNotification(last, input.wake)
      ) {
        break
      }
      if (!strippedOwnAdmittedDeposit) {
        strippedOwnAdmittedTailCreatedAt = getParentWakeMessageCreatedAt(last)
      }
      messages.pop()
      strippedOwnAdmittedDeposit = true
    }
  }
  const strippedInternalProgressTail = wakeIsTerminalBackgroundTaskFinal
    ? stripTrailingInternalBackgroundProgressNotifications(messages)
    : false
  const latestAssistantBlocksPrompt = latestAssistantTurnBlocksInternalPrompt(messages)
  const latestAssistantHasUnansweredQuestion = latestAssistantTurnHasUnansweredQuestion(messages)
  if (input.wake.allowInternalWakeTailRetry && latestInternalWakeTailOnlyBlocks(messages, input.wake)) {
    delete input.wake.toolCallDeferralStartedAt
    delete input.wake.allowInternalWakeTailRetry
    log("[background-agent] Retrying parent wake past matching internal wake tail:", { sessionID: input.sessionID })
    return { defer: false, skipPromptGateToolStateCheck: true }
  }
  if (!latestAssistantBlocksPrompt) {
    delete input.wake.toolCallDeferralStartedAt
    delete input.wake.allowEmptyAssistantTurnRetry
    delete input.wake.allowInternalWakeTailRetry
    return { defer: false, skipPromptGateToolStateCheck: strippedOwnAdmittedDeposit || strippedInternalProgressTail }
  }
  const now = input.now ?? Date.now()
  input.wake.toolCallDeferralStartedAt ??= now
  if (input.wake.allowEmptyAssistantTurnRetry && latestAssistantTurnIsCompletedEmptyNoProgress(messages)) {
    log("[background-agent] Retrying parent wake after completed empty assistant turn:", { sessionID: input.sessionID })
    return { defer: false, skipPromptGateToolStateCheck: true }
  }
  if (latestAssistantHasUnansweredQuestion) {
    log("[background-agent] Deferred parent wake because latest assistant question awaits user response:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false }
  }
  const latestAssistantHasStaleToolBlock = latestAssistantTurnHasToolBlock(messages)
    && !latestAssistantTurnHasFreshToolActivity(messages, now, input.toolCallDeferMaxMs)
  if (
    shouldResumeRetainedCompleteWakeAfterStaleAdmittedTail({
      wake: input.wake,
      strippedOwnAdmittedDeposit,
      strippedOwnAdmittedTailCreatedAt,
      latestAssistantHasStaleToolBlock,
      toolCallDeferMaxMs: input.toolCallDeferMaxMs,
      now,
    })
  ) {
    delete input.wake.toolCallDeferralStartedAt
    log("[background-agent] Retrying retained parent wake after admitted all-complete tail outlived stale tool deferral:", {
      sessionID: input.sessionID,
    })
    return { defer: false, skipPromptGateToolStateCheck: true }
  }
  if (
    now - input.wake.toolCallDeferralStartedAt >= input.toolCallDeferMaxMs
    && latestAssistantHasStaleToolBlock
  ) {
    // A reply dispatch here would fork a concurrent assistant turn: the turn is
    // still mid-flight, only its busy signals are quiet (silent tool, blind
    // instance-scoped status). Defer so the wake is admitted as noReply at most
    // and resumed by the idle/consumption machinery (ses_14a3ab27bffe incident).
    log("[background-agent] Holding parent wake during stale tool-call deferral:", { sessionID: input.sessionID })
    return { defer: true, skipPromptGateToolStateCheck: true }
  }
  if (
    now - input.wake.toolCallDeferralStartedAt >= input.toolCallDeferMaxMs
    && latestAssistantTurnHasStaleUnknownSubstantiveOutput(messages, now, input.toolCallDeferMaxMs)
  ) {
    log("[background-agent] Retrying parent wake after stale unknown-finish assistant output:", {
      sessionID: input.sessionID,
    })
    return { defer: false, skipPromptGateToolStateCheck: true }
  }
  log("[background-agent] Deferred parent wake because latest assistant turn blocks internal prompts:", {
    sessionID: input.sessionID,
  })
  return { defer: true, skipPromptGateToolStateCheck: false }
}

export function hasRecordedParentWakePromptMessage(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly acceptedMessageSkewMs: number
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => {
    const createdAt = getParentWakeMessageCreatedAt(message)
    if (createdAt === undefined) {
      return false
    }
    if (
      createdAt >= dispatchedAt - input.acceptedMessageSkewMs
      && parentWakeMessageIsInternalNotification(message, input.wake)
    ) {
      return true
    }
    return createdAt >= dispatchedAt && parentWakeMessageHasOutput(message)
  })
}

export function hasAssistantOutputAfterParentWakeAdmission(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
}): boolean {
  const admittedAt = input.wake.noReplyAdmittedAt
  if (admittedAt === undefined || !input.messages) {
    return false
  }
  let currentAdmissionSeen = false
  for (const message of input.messages) {
    const createdAt = getParentWakeMessageCreatedAt(message)
    if (parentWakeMessageIsInternalNotification(message, input.wake)) {
      if (createdAt === undefined || createdAt >= admittedAt) {
        currentAdmissionSeen = true
      }
      continue
    }
    if (!currentAdmissionSeen) {
      continue
    }
    const role = getParentWakeMessageRole(message)
    if (role !== "assistant" && role !== "tool") {
      continue
    }
    if (createdAt !== undefined && createdAt < admittedAt) {
      continue
    }
    if (parentWakeMessageHasOutput(message)) {
      return true
    }
  }
  return false
}

export function hasAssistantOrToolOutputAfterParentWake(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => parentWakeMessageHasOutputAfterWake(message, dispatchedAt))
}

function getParentWakeMessageRole(message: ParentWakeSessionMessage): string | undefined {
  return message.info?.role ?? message.role
}

function latestInternalWakeTailOnlyBlocks(
  messages: readonly ParentWakeSessionMessage[],
  wake: PendingParentWake,
): boolean {
  const latestMessage = messages[messages.length - 1]
  if (!latestMessage || !isSyntheticOrInternalUserMessage(latestMessage)) {
    return false
  }
  if (!parentWakeMessageIsInternalNotification(latestMessage, wake)) {
    return false
  }

  return !latestAssistantTurnBlocksInternalPrompt(messages.slice(0, -1))
}

function stripTrailingInternalBackgroundProgressNotifications(messages: ParentWakeSessionMessage[]): boolean {
  let stripped = false
  while (messages.length > 0) {
    const latestMessage = messages[messages.length - 1]
    if (
      !latestMessage
      || getParentWakeMessageRole(latestMessage) !== "user"
      || !isSyntheticOrInternalUserMessage(latestMessage)
      || !parentWakeMessageContainsNotificationMatching(latestMessage, isBackgroundTaskProgressNotification)
    ) {
      break
    }
    messages.pop()
    stripped = true
  }
  return stripped
}

function shouldResumeRetainedCompleteWakeAfterStaleAdmittedTail(input: {
  readonly wake: PendingParentWake
  readonly strippedOwnAdmittedDeposit: boolean
  readonly strippedOwnAdmittedTailCreatedAt: number | undefined
  readonly latestAssistantHasStaleToolBlock: boolean
  readonly toolCallDeferMaxMs: number
  readonly now: number
}): boolean {
  if (!input.wake.shouldReply || input.wake.noReplyAdmittedAt === undefined) {
    return false
  }
  if (!input.strippedOwnAdmittedDeposit || !input.latestAssistantHasStaleToolBlock) {
    return false
  }
  if (!input.wake.notifications.some(isFinalBackgroundTaskNotification)) {
    return false
  }
  if (
    input.strippedOwnAdmittedTailCreatedAt !== undefined
    && input.strippedOwnAdmittedTailCreatedAt < input.wake.noReplyAdmittedAt
  ) {
    return false
  }
  return input.now - input.wake.noReplyAdmittedAt >= input.toolCallDeferMaxMs
}

function parentWakeMessageHasOutput(message: ParentWakeSessionMessage): boolean {
  const role = getParentWakeMessageRole(message)
  if (role !== "assistant" && role !== "tool") {
    return false
  }
  const finish = message.info?.finish ?? message.finish
  const error = message.info?.error ?? message.error
  if (role === "assistant" && (finish === "error" || error !== undefined)) {
    return false
  }
  if (!message.parts || message.parts.length === 0) {
    return role === "assistant"
  }
  return message.parts.some(parentWakePartHasOutput)
}

function parentWakeMessageHasOutputAfterWake(message: ParentWakeSessionMessage, dispatchedAt: number): boolean {
  const role = getParentWakeMessageRole(message)
  if (role !== "assistant" && role !== "tool") {
    return false
  }
  const finish = message.info?.finish ?? message.finish
  const error = message.info?.error ?? message.error
  if (role === "assistant" && (finish === "error" || error !== undefined)) {
    return false
  }

  const createdAt = getParentWakeMessageCreatedAt(message)
  if (createdAt !== undefined && createdAt >= dispatchedAt) {
    if (!message.parts || message.parts.length === 0) {
      return role === "assistant"
    }
    return message.parts.some(parentWakePartHasOutput)
  }

  return message.parts?.some((part) => {
    const partActivityAt = getParentWakeMessagePartActivityAt(part)
    return partActivityAt !== undefined
      && partActivityAt >= dispatchedAt
      && parentWakePartHasOutput(part)
  }) ?? false
}

function parentWakePartHasOutput(part: NonNullable<ParentWakeSessionMessage["parts"]>[number]): boolean {
  if (part.type === "text" || part.type === "reasoning") {
    return typeof part.text === "string" && part.text.trim().length > 0
  }
  if (
    part.type === "tool"
    || part.type === "tool_use"
    || part.type === "tool-call"
    || part.type === "tool-invocation"
    || part.type === "tool_result"
    || part.type === "tool-result"
  ) {
    return true
  }
  if (part.content !== undefined) {
    if (typeof part.content === "string") {
      return part.content.trim().length > 0
    }
    if (Array.isArray(part.content)) {
      return part.content.length > 0
    }
    return true
  }
  return false
}


function parentWakeMessageIsInternalNotification(
  message: ParentWakeSessionMessage,
  wake: PendingParentWake,
): boolean {
  return isSyntheticOrInternalUserMessage(message) && parentWakeMessageContainsNotification(message, wake)
}

function parentWakeMessageContainsNotification(message: ParentWakeSessionMessage, wake: PendingParentWake): boolean {
  return parentWakeMessageContainsNotificationMatching(
    message,
    (notification) => wake.notifications.some((wakeNotification) => notification.includes(wakeNotification)),
  )
}

function parentWakeMessageContainsNotificationMatching(
  message: ParentWakeSessionMessage,
  matchesNotification: (notification: string) => boolean,
): boolean {
  if (getParentWakeMessageRole(message) !== "user") {
    return false
  }
  return message.parts?.some((part) => typeof part.text === "string" && matchesNotification(part.text)) ?? false
}

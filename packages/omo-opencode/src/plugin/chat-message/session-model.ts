import { getSessionAgent, subagentSessions, getMainSessionID } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { getStoredSessionModel, setSessionModel } from "../../shared/session-model-state"
import type { ChatMessageHandlerOutput, ChatMessageInput, SessionModelOverride, SessionModelSelection } from "./types"

function resolveCurrentAgent(input: ChatMessageInput): string | undefined {
  return input.agent ?? getSessionAgent(input.sessionID)
}

function hasMatchingAgentOwner(input: ChatMessageInput, storedAgent: string | undefined): boolean {
  if (!storedAgent) {
    return true
  }

  const currentAgent = resolveCurrentAgent(input)
  if (!currentAgent) {
    return false
  }

  return getAgentConfigKey(storedAgent) === getAgentConfigKey(currentAgent)
}

export function getStoredMainSessionModel(
  input: ChatMessageInput,
  isFirstMessage: boolean,
): SessionModelSelection | undefined {
  if (isFirstMessage) {
    return undefined
  }

  if (subagentSessions.has(input.sessionID)) {
    return undefined
  }

  if (getMainSessionID() !== input.sessionID) {
    return undefined
  }

  if (input.model) {
    return undefined
  }

  const storedModel = getStoredSessionModel(input.sessionID)
  if (!storedModel || !hasMatchingAgentOwner(input, storedModel.agent)) {
    return undefined
  }

  return {
    model: { providerID: storedModel.providerID, modelID: storedModel.modelID },
    ...(storedModel.variant ? { variant: storedModel.variant } : {}),
  }
}

function isSessionModelOverride(value: unknown): value is SessionModelOverride {
  return typeof value === "object" && value !== null &&
    "providerID" in value && typeof value.providerID === "string" &&
    "modelID" in value && typeof value.modelID === "string"
}

function readVariant(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export function recordSessionModel(input: ChatMessageInput, output: ChatMessageHandlerOutput): void {
  const modelOverride = output.message.model
  const agent = resolveCurrentAgent(input)
  if (isSessionModelOverride(modelOverride)) {
    const variant = readVariant(modelOverride.variant)
      ?? readVariant(output.message["variant"])
      ?? readVariant(input.model?.variant)
    setSessionModel(input.sessionID, {
      providerID: modelOverride.providerID,
      modelID: modelOverride.modelID,
      ...(variant ? { variant } : {}),
    }, agent)
  } else if (input.model) {
    const variant = readVariant(output.message["variant"]) ?? readVariant(input.model.variant)
    setSessionModel(input.sessionID, {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      ...(variant ? { variant } : {}),
    }, agent)
  }
}

import { parseModelString } from "../../shared/model-string-parser"
import { lowerReasoningForModel } from "../../shared/agent-variant"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"

export function buildRetryModelPayload(
  model: string,
  agentSettings?: { reasoning?: string; variant?: string; reasoningEffort?: string },
): { model: { providerID: string; modelID: string }; variant?: string; reasoningEffort?: string } | undefined {
  const parsedModel = parseModelString(model)
  if (!parsedModel) {
    return undefined
  }

  const loweredReasoning = parsedModel.variant
    ? {}
    : lowerReasoningForModel(agentSettings?.reasoning, parsedModel)
  const variant = parsedModel.variant ?? agentSettings?.variant ?? loweredReasoning.variant
  const reasoningEffort = agentSettings?.reasoningEffort
    ?? (parsedModel.variant ? undefined : loweredReasoning.reasoningEffort)
  const modelID = transformModelForProvider(parsedModel.providerID, parsedModel.modelID)

  const payload: { model: { providerID: string; modelID: string }; variant?: string; reasoningEffort?: string } = {
    model: {
      providerID: parsedModel.providerID,
      modelID,
    },
  }

  if (variant) {
    payload.variant = variant
  }
  if (reasoningEffort) {
    payload.reasoningEffort = reasoningEffort
  }

  return payload
}

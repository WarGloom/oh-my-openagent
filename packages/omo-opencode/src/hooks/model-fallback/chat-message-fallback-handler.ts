import { log } from "../../shared/logger"
import { getTaskToastManager } from "../../features/task-toast-manager"
import type { ChatMessageHandlerOutput, ChatMessageInput } from "../../plugin/chat-message"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import type { ResolvedFallbackModel } from "./hook"

export async function applyFallbackToChatMessage(params: {
  input: ChatMessageInput
  output: ChatMessageHandlerOutput
  fallback: ResolvedFallbackModel
  toast?: (input: {
    title: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }) => void | Promise<void>
  onApplied?: (input: {
    sessionID: string
    providerID: string
    modelID: string
    variant?: string
  }) => void | Promise<void>
  lastToastKey: Map<string, string>
}): Promise<void> {
  const { input, output, fallback, toast, onApplied, lastToastKey } = params
  const { sessionID } = input
  if (!sessionID) return

  output.message["model"] = {
    providerID: fallback.providerID,
    modelID: fallback.modelID,
  }
  const loweredReasoning = applySessionPromptParams(sessionID, fallback)
  const variant = fallback.variant ?? loweredReasoning.variant
  if (variant !== undefined) {
    output.message["variant"] = variant
  } else {
    delete output.message["variant"]
  }

  if (toast) {
    const key = `${sessionID}:${fallback.providerID}/${fallback.modelID}:${variant ?? ""}`
    if (lastToastKey.get(sessionID) !== key) {
      lastToastKey.set(sessionID, key)
      const variantLabel = variant ? ` (${variant})` : ""
      await Promise.resolve(
        toast({
          title: "Model fallback",
          message: `Using ${fallback.providerID}/${fallback.modelID}${variantLabel}`,
          variant: "warning",
          duration: 5000,
        }),
      )
    }
  }

  if (onApplied) {
    await Promise.resolve(
      onApplied({
        sessionID,
        providerID: fallback.providerID,
        modelID: fallback.modelID,
        variant,
      }),
    )
  }

  const toastManager = getTaskToastManager()
  if (toastManager) {
    const variantLabel = variant ? ` (${variant})` : ""
    toastManager.updateTaskModelBySession(sessionID, {
      model: `${fallback.providerID}/${fallback.modelID}${variantLabel}`,
      type: "runtime-fallback",
    })
  }

  log("[model-fallback] Applied fallback model: " + JSON.stringify(fallback))
}

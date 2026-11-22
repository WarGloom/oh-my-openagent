import type { ModelFallbackInfo } from "../../features/task-toast-manager/types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "./types"

export interface CategoryResolutionResult {
  agentToUse: string
  categoryModel: DelegatedModelConfig | undefined
  categoryPromptAppend: string | undefined
  maxPromptTokens?: number
  modelInfo: ModelFallbackInfo | undefined
  actualModel: string | undefined
  isUnstableAgent: boolean
  fallbackChain?: FallbackEntry[] // For runtime retry on model errors
  error?: string
  routingNotice?: string
  /** Settles after the background Jev observation of an explicit category; undefined when Jev agrees or is unsure. */
  routingHint?: Promise<string | undefined>
  finishRoutingHint?: (status: "delivered" | "missed_budget" | "not_produced") => void
}

export function categoryResolutionError(error: string): CategoryResolutionResult {
  return {
    agentToUse: "",
    categoryModel: undefined,
    categoryPromptAppend: undefined,
    maxPromptTokens: undefined,
    modelInfo: undefined,
    actualModel: undefined,
    isUnstableAgent: false,
    error,
  }
}

import type { AgentOverrides } from "../../config/schema"
import type { DelegatedModelConfig } from "./types"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { fuzzyMatchModel } from "../../shared/model-availability"
import { buildFallbackChainFromModels, findMostSpecificFallbackEntry } from "../../shared/fallback-chain-from-models"
import { normalizeModelFormat } from "../../shared/model-format-normalizer"
import { flattenToFallbackModelStrings, normalizeFallbackModels } from "../../shared/model-resolver"
import { AGENT_MODEL_REQUIREMENTS, type FallbackEntry } from "../../shared/model-requirements"
import { log } from "../../shared/logger"
import { getAvailableModelsForDelegateTask } from "./available-models"
import { applyCategoryParams } from "./delegated-model-config"
import type { ExecutorContext } from "./executor-types"
import { applyFallbackEntrySettings } from "./fallback-entry-settings"
import { resolveEffectiveFallbackEntry } from "./fallback-entry-resolution"
import { resolveModelForDelegateTask } from "./model-selection"
import type { AgentInfo } from "./subagent-discovery"
import type { ResolvedSubagentModel } from "./subagent-resolution-types"

function findAgentOverride(agentOverrides: AgentOverrides | undefined, agentConfigKey: string) {
  return agentOverrides?.[agentConfigKey]
    ?? Object.entries(agentOverrides ?? {}).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1]
}

export async function resolveSubagentModel(
  agentToUse: string,
  matchedAgent: AgentInfo,
  executorCtx: ExecutorContext,
): Promise<ResolvedSubagentModel> {
  let categoryModel = undefined
  let fallbackChain = undefined
  let selectedEntry: FallbackEntry | undefined

  const agentConfigKey = getAgentConfigKey(agentToUse)
  const agentOverride = findAgentOverride(executorCtx.agentOverrides, agentConfigKey)
  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey]
  const agentCategoryConfig = agentOverride?.category
    ? executorCtx.userCategories?.[agentOverride.category]
    : undefined
  const agentCategoryModel = agentCategoryConfig?.model
  const [primary, ...modelFallbacks] = agentOverride?.models ?? []
  const agentModel = primary === undefined
    ? agentOverride?.model
    : typeof primary === "string" ? primary : primary.model
  const hasExplicitUserModel = Boolean(agentModel ?? agentCategoryModel)
  const normalizedAgentFallbackModels = normalizeFallbackModels(
    (agentOverride?.models !== undefined ? modelFallbacks : agentOverride?.fallback_models)
    ?? agentCategoryConfig?.fallback_models
  )

  const availableModels = await getAvailableModelsForDelegateTask(executorCtx.client)
  const normalizedMatchedModel = matchedAgent.model
    ? normalizeModelFormat(matchedAgent.model)
    : undefined
  const matchedAgentModelStr = normalizedMatchedModel
    ? `${normalizedMatchedModel.providerID}/${normalizedMatchedModel.modelID}`
    : undefined

  if (agentModel || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution = resolveModelForDelegateTask({
      userModel: agentModel ?? agentCategoryModel,
      userFallbackModels: flattenToFallbackModelStrings(normalizedAgentFallbackModels),
      categoryDefaultModel: matchedAgentModelStr,
      fallbackChain: agentRequirement?.fallbackChain,
      availableModels,
      systemDefaultModel: undefined,
    })

    const resolutionSkipped = resolution && "skipped" in resolution

    if (resolution && !resolutionSkipped) {
      const normalized = normalizeModelFormat(resolution.model)
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? resolution.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
      }
    } else if (resolutionSkipped && (agentModel ?? agentCategoryModel)) {
      const explicitModel = agentModel ?? agentCategoryModel
      const normalized = explicitModel ? normalizeModelFormat(explicitModel) : undefined
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
        log("[delegate-task] Cold cache: using explicit user override for subagent", {
          agent: agentToUse,
          model: agentModel ?? agentCategoryModel,
        })
      }
    }

    const defaultProviderID = categoryModel?.providerID
      ?? normalizedMatchedModel?.providerID
      ?? "opencode"
    const configuredFallbackChain = buildFallbackChainFromModels(
      normalizedAgentFallbackModels,
      defaultProviderID,
    )
    fallbackChain = configuredFallbackChain
      ?? ((resolutionSkipped || hasExplicitUserModel) ? undefined : agentRequirement?.fallbackChain)
    const effectiveEntry = resolveEffectiveFallbackEntry({
      categoryModel,
      configuredFallbackChain,
      resolution,
    })
    const modelChain = buildFallbackChainFromModels(agentOverride?.models, defaultProviderID)
    selectedEntry = categoryModel && modelChain
      ? findMostSpecificFallbackEntry(categoryModel.providerID, categoryModel.modelID, modelChain)
      : effectiveEntry

    if (categoryModel && effectiveEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry,
        variantOverride: agentOverride?.variant,
      })
    }
  }

  if (!categoryModel && normalizedMatchedModel) {
    const fullModel = `${normalizedMatchedModel.providerID}/${normalizedMatchedModel.modelID}`
    if (availableModels.size === 0 || fuzzyMatchModel(fullModel, availableModels, [normalizedMatchedModel.providerID])) {
      categoryModel = normalizedMatchedModel
    } else {
      log("[delegate-task] Skipping unavailable agent default model", {
        agent: agentToUse,
        model: fullModel,
      })
    }
  }

  const reasoning = selectedEntry?.reasoning
    ?? (agentOverride?.models !== undefined ? selectedEntry?.variant : undefined)
    ?? agentOverride?.reasoning
    ?? agentOverride?.variant
    ?? agentOverride?.reasoningEffort
    ?? matchedAgent.variant
  if (categoryModel && reasoning !== undefined) {
    categoryModel = { ...categoryModel, reasoning }
  }

  return { categoryModel, fallbackChain }
}

// Proactive, config-driven fallback chain for an already-resolved agent, using the same
// `agents.<key>.fallback_models` (or its category's `fallback_models`) source and the same
// `buildFallbackChainFromModels` builder as `resolveSubagentModel`. Used by the team-mode
// custom project-agent branch, which resolves its own model separately and only needs the chain.
export function resolveAgentFallbackChain(
  agentToUse: string,
  agentModel: DelegatedModelConfig | undefined,
  executorCtx: ExecutorContext,
): FallbackEntry[] | undefined {
  const agentConfigKey = getAgentConfigKey(agentToUse)
  const agentOverride = findAgentOverride(executorCtx.agentOverrides, agentConfigKey)
  const agentCategoryConfig = agentOverride?.category
    ? executorCtx.userCategories?.[agentOverride.category]
    : undefined
  return buildFallbackChainFromModels(
    agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models,
    agentModel?.providerID,
  )
}

import type { AgentOverrides } from "../../config/schema"
import { getNativeUnavailableModels } from "../../hooks/runtime-fallback/native-controller"
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
import { distributeTaskModels } from "./models-distribution"

function findAgentOverride(agentOverrides: AgentOverrides | undefined, agentConfigKey: string) {
  return (
    agentOverrides?.[agentConfigKey] ??
    Object.entries(agentOverrides ?? {}).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1]
  )
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
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined
  const chainConfig = agentOverride?.models?.length
    ? agentOverride
    : !agentOverride?.model
      ? agentCategoryConfig
      : undefined
  const canonicalModels = !chainConfig?.models?.length
    ? undefined
    : chainConfig.models_distribution === "round_robin"
      ? [
          ...distributeTaskModels(
            chainConfig === agentOverride ? `agent:${agentConfigKey}` : `category:${agentOverride?.category}`,
            chainConfig.models,
            "round_robin",
          ),
        ]
      : [...chainConfig.models]
  const firstEntry = canonicalModels?.[0]
  const explicitModel =
    (typeof firstEntry === "string" ? firstEntry : firstEntry?.model) ??
    agentOverride?.model ??
    agentCategoryConfig?.model
  const hasExplicitUserModel = Boolean(explicitModel)
  const normalizedAgentFallbackModels = normalizeFallbackModels(
    canonicalModels?.slice(1) ?? agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models,
  )

  const available = await getAvailableModelsForDelegateTask(executorCtx.client)
  const availableModels = executorCtx.requiredModel
    ? new Set([...available].filter((model) => model === executorCtx.requiredModel))
    : available
  const normalizedMatchedModel = matchedAgent.model ? normalizeModelFormat(matchedAgent.model) : undefined
  const matchedAgentModelStr = normalizedMatchedModel
    ? `${normalizedMatchedModel.providerID}/${normalizedMatchedModel.modelID}`
    : undefined

  if (canonicalModels || agentOverride?.model || agentCategoryConfig?.model || agentRequirement || matchedAgent.model) {
    const resolution = resolveModelForDelegateTask(
      {
        userModel: explicitModel,
        userFallbackModels: flattenToFallbackModelStrings(normalizedAgentFallbackModels),
        categoryDefaultModel: matchedAgentModelStr,
        fallbackChain: agentRequirement?.fallbackChain,
        availableModels,
        systemDefaultModel: undefined,
      },
      await getNativeUnavailableModels(executorCtx.client),
    )

    const resolutionSkipped = resolution && "skipped" in resolution

    if (resolution && !resolutionSkipped) {
      const normalized = normalizeModelFormat(resolution.model)
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? resolution.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
      }
    } else if (resolutionSkipped && explicitModel) {
      const normalized = explicitModel ? normalizeModelFormat(explicitModel) : undefined
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
        log("[delegate-task] Cold cache: using explicit user override for subagent", {
          agent: agentToUse,
          model: explicitModel,
        })
      }
    }

    const defaultProviderID = categoryModel?.providerID ?? normalizedMatchedModel?.providerID ?? "opencode"
    const configuredFallbackChain = buildFallbackChainFromModels(normalizedAgentFallbackModels, defaultProviderID)
    const canonicalChain = buildFallbackChainFromModels(canonicalModels, defaultProviderID)
    const canonicalEntry =
      categoryModel && canonicalChain
        ? findMostSpecificFallbackEntry(categoryModel.providerID, categoryModel.modelID, canonicalChain)
        : undefined
    fallbackChain =
      configuredFallbackChain ??
      (resolutionSkipped || hasExplicitUserModel ? undefined : agentRequirement?.fallbackChain)
    if (canonicalChain && canonicalEntry) {
      fallbackChain = canonicalChain.slice(canonicalChain.indexOf(canonicalEntry) + 1)
    }
    // The resolver reports which configured rung it picked; keep that rung's settings even when a
    // later rung's model id is a longer prefix of the resolved model.
    const selectedIndex =
      resolution && !resolutionSkipped && resolution.matchedFallback ? resolution.userFallbackIndex : undefined
    const selectedModelEntry = selectedIndex !== undefined ? normalizedAgentFallbackModels?.[selectedIndex] : undefined
    const indexedEntry =
      selectedModelEntry !== undefined
        ? buildFallbackChainFromModels([selectedModelEntry], defaultProviderID)?.[0]
        : undefined
    const effectiveEntry =
      indexedEntry ??
      canonicalEntry ??
      resolveEffectiveFallbackEntry({
        categoryModel,
        configuredFallbackChain,
        resolution,
      })
    selectedEntry = effectiveEntry

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
    if (
      availableModels.size === 0 ||
      fuzzyMatchModel(fullModel, availableModels, [normalizedMatchedModel.providerID])
    ) {
      categoryModel = normalizedMatchedModel
    } else {
      log("[delegate-task] Skipping unavailable agent default model", {
        agent: agentToUse,
        model: fullModel,
      })
    }
  }

  const reasoning =
    selectedEntry?.reasoning ??
    (agentOverride?.models !== undefined ? selectedEntry?.variant : undefined) ??
    agentOverride?.reasoning ??
    agentOverride?.variant ??
    agentOverride?.reasoningEffort ??
    matchedAgent.variant
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
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined
  return buildFallbackChainFromModels(
    agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models,
    agentModel?.providerID,
  )
}

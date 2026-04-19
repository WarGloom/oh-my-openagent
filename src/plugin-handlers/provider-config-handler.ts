import type { ModelCacheState, VisionCapableModel } from "../plugin-state";
import { setVisionCapableModelsCache } from "../shared/vision-capable-models-cache"

type ProviderConfig = {
  options?: { headers?: Record<string, string> };
  models?: Record<string, ProviderModelConfig>;
};

type ProviderModelConfig = {
  limit?: { context?: number };
  modalities?: {
    input?: string[];
  };
  capabilities?: {
    input?: {
      image?: boolean;
    };
  };
}

type ProviderConfigExperimental = {
  disableAnthropicBetaHeaders?: boolean
}

function supportsImageInput(modelConfig: ProviderModelConfig | undefined): boolean {
  if (modelConfig?.modalities?.input?.includes("image")) {
    return true
  }

  return modelConfig?.capabilities?.input?.image === true
}

export function applyProviderConfig(params: {
  config: Record<string, unknown>;
  modelCacheState: ModelCacheState;
  experimental?: ProviderConfigExperimental;
}): void {
  const providers = params.config.provider as
    | Record<string, ProviderConfig>
    | undefined;
  const modelContextLimitsCache = params.modelCacheState.modelContextLimitsCache;

  modelContextLimitsCache.clear()

  const anthropicBeta = providers?.anthropic?.options?.headers?.["anthropic-beta"];
  const disableAnthropicBetaHeaders = params.experimental?.disableAnthropicBetaHeaders === true
  params.modelCacheState.anthropicContext1MEnabled =
    disableAnthropicBetaHeaders
      ? false
      : anthropicBeta?.includes("context-1m") ?? false

  const visionCapableModelsCache = params.modelCacheState.visionCapableModelsCache
    ?? new Map<string, VisionCapableModel>()
  params.modelCacheState.visionCapableModelsCache = visionCapableModelsCache
  visionCapableModelsCache.clear()
  setVisionCapableModelsCache(visionCapableModelsCache)

  if (!providers) return;

  for (const [providerID, providerConfig] of Object.entries(providers)) {
    const models = providerConfig?.models;
    if (!models) continue;

    for (const [modelID, modelConfig] of Object.entries(models)) {
      if (supportsImageInput(modelConfig)) {
        visionCapableModelsCache.set(
          `${providerID}/${modelID}`,
          { providerID, modelID },
        )
      }

      const contextLimit = modelConfig?.limit?.context;
      if (!contextLimit) continue;

      modelContextLimitsCache.set(
        `${providerID}/${modelID}`,
        contextLimit,
      );
    }
  }
}

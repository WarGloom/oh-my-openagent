import type { ModelCacheState, VisionCapableModel } from "../plugin-state";
import { setVisionCapableModelsCache } from "../shared/vision-capable-models-cache"

type ProviderConfig = {
  options?: { headers?: Record<string, string>; fetch?: ProviderFetch };
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

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const ANTHROPIC_BETA_HEADER = "anthropic-beta"
const FETCH_WRAPPER_MARKER = Symbol("omoAnthropicBetaStripper")

function isAnthropicProvider(providerID: string): boolean {
  const normalized = providerID.toLowerCase()
  return normalized === "anthropic"
    || normalized === "google-vertex-anthropic"
    || normalized === "aws-bedrock-anthropic"
}

function stripAnthropicBetaHeader(headersInit: RequestInit["headers"] | undefined): Headers | undefined {
  if (!headersInit) return undefined
  const headers = new Headers(headersInit)
  headers.delete(ANTHROPIC_BETA_HEADER)
  return headers
}

function wrapFetchToStripAnthropicBeta(existingFetch?: ProviderFetch): ProviderFetch {
  if (existingFetch && (existingFetch as ProviderFetch & { [FETCH_WRAPPER_MARKER]?: boolean })[FETCH_WRAPPER_MARKER]) {
    return existingFetch
  }

  const baseFetch = existingFetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init))
  const wrappedFetch: ProviderFetch = async (input, init) => {
    if (input instanceof Request) {
      const requestHeaders = new Headers(input.headers)
      requestHeaders.delete(ANTHROPIC_BETA_HEADER)

      const overrideHeaders = stripAnthropicBetaHeader(init?.headers)
      if (overrideHeaders) {
        overrideHeaders.forEach((value, key) => {
          requestHeaders.set(key, value)
        })
      }

      return baseFetch(new Request(input, { ...init, headers: requestHeaders }), undefined)
    }

    const nextHeaders = stripAnthropicBetaHeader(init?.headers)
    return baseFetch(input, nextHeaders ? { ...init, headers: nextHeaders } : init)
  }

  ;(wrappedFetch as ProviderFetch & { [FETCH_WRAPPER_MARKER]?: boolean })[FETCH_WRAPPER_MARKER] = true
  return wrappedFetch
}

function applyAnthropicBetaStripping(providerConfig: ProviderConfig | undefined): void {
  if (!providerConfig) return

  providerConfig.options ??= {}
  if (providerConfig.options.headers) {
    delete providerConfig.options.headers[ANTHROPIC_BETA_HEADER]
  }
  providerConfig.options.fetch = wrapFetchToStripAnthropicBeta(providerConfig.options.fetch)
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

  if (disableAnthropicBetaHeaders) {
    for (const [providerID, providerConfig] of Object.entries(providers)) {
      if (!isAnthropicProvider(providerID)) continue
      applyAnthropicBetaStripping(providerConfig)
    }
  }

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

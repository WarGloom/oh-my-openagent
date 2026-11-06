import {
  resolveModelForDelegateTask as resolveModelForDelegateTaskCore,
  type DelegateModelResolutionInput,
  type DelegateModelResolutionResult,
} from "@oh-my-opencode/delegate-core"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import { log } from "../../shared/logger"

export type { DelegateModelResolutionInput, DelegateModelResolutionResult }

export function resolveModelForDelegateTask(
  input: DelegateModelResolutionInput,
  unavailableModels?: ReadonlySet<string>,
): DelegateModelResolutionResult {
  const connectedProviders =
    input.availableModels.size === 0 ? connectedProvidersCache.readConnectedProvidersCache() : null

  const deps = {
    connectedProviders,
    hasProviderModelsCache: connectedProvidersCache.hasProviderModelsCache(),
    hasConnectedProvidersCache: connectedProvidersCache.hasConnectedProvidersCache(),
    log,
  }
  const baseline = resolveModelForDelegateTaskCore(input, deps)
  if (
    !unavailableModels?.size ||
    input.availableModels.size === 0 ||
    !baseline ||
    "skipped" in baseline ||
    !unavailableModels.has(baseline.model)
  ) {
    return baseline
  }
  if (
    (input.userModel && !input.userFallbackModels?.length) ||
    (!input.userModel && input.isUserConfiguredCategoryModel)
  ) {
    return baseline
  }

  const availableModels = new Set([...input.availableModels].filter((model) => !unavailableModels.has(model)))
  if (availableModels.size === 0) return baseline

  const alternative = resolveModelForDelegateTaskCore(
    {
      ...input,
      availableModels,
      systemDefaultModel:
        input.systemDefaultModel && unavailableModels.has(input.systemDefaultModel)
          ? undefined
          : input.systemDefaultModel,
    },
    deps,
  )
  return alternative && !("skipped" in alternative) && !unavailableModels.has(alternative.model)
    ? alternative
    : baseline
}

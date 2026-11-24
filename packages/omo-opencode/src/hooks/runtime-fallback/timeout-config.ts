import type { RuntimeFallbackConfig } from "../../config"
import { parseModelString } from "../../shared/model-string-parser"

export function firstResponseOverrideMs(config: RuntimeFallbackConfig | undefined, model: string | undefined) {
  if (model === undefined || config === undefined) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  const provider = model.slice(0, slash)
  const { model_timeouts, provider_timeouts } = config
  const seconds =
    (model_timeouts && Object.hasOwn(model_timeouts, model) ? model_timeouts[model] : undefined) ??
    (provider_timeouts && Object.hasOwn(provider_timeouts, provider) ? provider_timeouts[provider] : undefined)
  return seconds === undefined ? undefined : seconds * 1000
}

export function hasTimeoutDrivenFallbackEnabled(config: RuntimeFallbackConfig): boolean {
  return (
    (config.timeout_seconds ?? 0) > 0 ||
    (config.first_progress_timeout_seconds ?? 0) > 0 ||
    (config.stall_timeout_seconds ?? 0) > 0 ||
    (config.hard_timeout_seconds ?? 0) > 0
  )
}

export function legacyFirstResponseOverrideMs(config: RuntimeFallbackConfig | undefined, model: string | undefined) {
  if (!config?.model_timeouts && !config?.provider_timeouts) return undefined
  const parsed = model && parseModelString(model)
  return parsed ? firstResponseOverrideMs(config, `${parsed.providerID}/${parsed.modelID}`) : undefined
}

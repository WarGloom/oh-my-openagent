import type { RuntimeFallbackConfig } from "../../config"

export function hasTimeoutDrivenFallbackEnabled(config: RuntimeFallbackConfig): boolean {
  return (config.timeout_seconds ?? 0) > 0
    || (config.first_progress_timeout_seconds ?? 0) > 0
    || (config.stall_timeout_seconds ?? 0) > 0
    || (config.hard_timeout_seconds ?? 0) > 0
}

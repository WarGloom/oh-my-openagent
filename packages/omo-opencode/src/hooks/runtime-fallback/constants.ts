/**
 * Runtime Fallback Hook - Constants
 *
 * Default values and configuration constants for the runtime fallback feature.
 */

import { RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS } from "@oh-my-opencode/model-core"
import type { RuntimeFallbackConfig } from "../../config"

/**
 * Default configuration values for runtime fallback
 */
export const DEFAULT_CONFIG: Required<RuntimeFallbackConfig> = {
  enabled: false,
  retry_on_errors: [413, 429, 500, 502, 503, 504],
  max_fallback_attempts: 3,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  first_progress_timeout_seconds: 30,
  stall_timeout_seconds: 600,
  hard_timeout_seconds: 1800,
  notify_on_fallback: true,
  restore_primary_after_cooldown: false,
}

/**
 * Error patterns that indicate rate limiting or temporary failures
 * These are checked in addition to HTTP status codes
 */
export const RETRYABLE_ERROR_PATTERNS = RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS

/**
 * Hook name for identification and logging
 */
export const HOOK_NAME = "runtime-fallback"

/**
 * Fallback first-prompt watchdog timeout for direct factory callers.
 * The runtime hook passes runtime_fallback.first_progress_timeout_seconds explicitly.
 */
export const DEFAULT_FIRST_PROMPT_WATCHDOG_MS = DEFAULT_CONFIG.first_progress_timeout_seconds * 1000

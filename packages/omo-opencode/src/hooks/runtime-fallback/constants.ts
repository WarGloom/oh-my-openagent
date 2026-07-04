/**
 * Runtime Fallback Hook - Constants
 *
 * Default values and configuration constants for the runtime fallback feature.
 */

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
export const RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /an\s+error\s+occurred\s+while\s+processing\s+your\s+request/i,
  /quota\s+will\s+reset\s+after/i,
  /quota.?exceeded/i,
  /hit\s+your\s+limit/i,
  /reached\s+your\s+limit/i,
  /resets\s+\d/i,
  /exceeded.*quota/i,
  /usage\s*quota/i,
  /exhausted\s+your\s+capacity/i,
  /limit\s+exhausted/i,
  /all\s+credentials\s+for\s+model/i,
  /cool(?:ing)?\s+down/i,
  /model.{0,20}?not.{0,10}?supported/i,
  /model_not_supported/i,
  /service.?unavailable/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/,
  /使用上限/,
  /频率限制/,
  /请求过于频繁/,
  /暂时不可用/,
  /服务不可用/,
  /请稍后重试/,
]

/**
 * Hook name for identification and logging
 */
export const HOOK_NAME = "runtime-fallback"

/**
 * Fallback first-prompt watchdog timeout for direct factory callers.
 * The runtime hook passes runtime_fallback.first_progress_timeout_seconds explicitly.
 */
export const DEFAULT_FIRST_PROMPT_WATCHDOG_MS = DEFAULT_CONFIG.first_progress_timeout_seconds * 1000

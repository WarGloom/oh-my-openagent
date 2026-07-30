import { z } from "zod"

export const RuntimeFallbackConfigSchema = z.object({
  /** Enable runtime fallback (default: false) */
  enabled: z.boolean().optional(),
  /** HTTP status codes that trigger fallback (default: [413, 429, 500, 502, 503, 504]) */
  retry_on_errors: z.array(z.number()).optional(),
  /** Maximum fallback attempts per session (default: 3) */
  max_fallback_attempts: z.number().min(1).max(20).optional(),
  /** Cooldown in seconds before retrying a failed model (default: 60) */
  cooldown_seconds: z.number().min(0).optional(),
  /** Legacy alias for first_progress_timeout_seconds. Set to 0 to disable timeout-based fallback and provider retry-message detection; direct retryable errors still fallback. */
  timeout_seconds: z.number().min(0).optional(),
  /** Timeout in seconds before first assistant/model progress triggers fallback (default: timeout_seconds or 30). */
  first_progress_timeout_seconds: z.number().min(0).optional(),
  /** Timeout in seconds after progress stalls before trying the next model (default: 600). */
  stall_timeout_seconds: z.number().min(0).optional(),
  /** Absolute timeout in seconds for one fallback attempt, independent of progress (default: 1800). */
  hard_timeout_seconds: z.number().min(0).optional(),
  /** Show toast notification when switching to fallback model (default: true) */
  notify_on_fallback: z.boolean().optional(),
  restore_primary_after_cooldown: z.boolean().optional(),
})

export type RuntimeFallbackConfig = z.infer<typeof RuntimeFallbackConfigSchema>

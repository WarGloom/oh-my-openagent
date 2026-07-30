export const HOOK_NAME = "compaction-context-injector"
export const AGENT_RECOVERY_PROMPT = "[restore checkpointed session agent configuration after compaction]"
export const NO_TEXT_TAIL_THRESHOLD = 5
export const RECOVERY_COOLDOWN_MS = 60_000
export const RECENT_COMPACTION_WINDOW_MS = 10 * 60 * 1000
/** Stop attempting recovery after this many consecutive failures to avoid
 *  wasting context on sessions with tight token budgets (e.g. copilot 128k). */
export const MAX_CONSECUTIVE_RECOVERY_FAILURES = 2

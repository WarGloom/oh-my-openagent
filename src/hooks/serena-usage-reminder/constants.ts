export const HOOK_NAME = "serena-usage-reminder"

export const GREP_USES_THRESHOLD = 3
export const READ_USES_THRESHOLD = 3
export const NON_SYMBOLIC_USES_THRESHOLD = 4

export const MIN_DENY_INTERVAL_MS = 120_000

export const SERENA_TOOL_PREFIX = "serena"

export const GREP_TOOLS = new Set(["grep"])

export const READ_TOOLS = new Set(["read", "glob"])

export const EXCLUDED_AGENT_KEYS = new Set([
  "multimodal-looker",
  "compaction",
])

export const HOOK_NAME = "serena-navigation-guard"

export const MANUAL_NAVIGATION_TOOLS = new Set([
  "grep",
  "glob",
  "read",
])

export const SERENA_TOOL_PREFIX = "serena_"

export const SERENA_NAVIGATION_TOOL_HINTS = [
  "serena_activate_project",
  "serena_check_onboarding_performed",
  "serena_find_file",
  "serena_search_for_pattern",
  "serena_get_symbols_overview",
  "serena_find_symbol",
  "serena_find_referencing_symbols",
  "serena_read_file",
]

export const NON_CODE_FILE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".log",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".lock",
  ".csv",
  ".tsv",
  ".xml",
])

export const EXCLUDED_AGENT_KEYS = new Set([
  "explore",
  "librarian",
  "multimodal-looker",
  "compaction",
])

export const MAX_VIOLATIONS_BEFORE_FALLBACK = 3

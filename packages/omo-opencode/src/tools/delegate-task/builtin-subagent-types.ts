import { getAgentConfigKey } from "../../shared/agent-display-names"

export interface BuiltinSubagentType {
  name: string
  description: string
}

const DISABLED_DIRECT_SUBAGENT_TYPE_MESSAGES = {
  hephaestus: {
    guard: 'Use category="deep" for autonomous implementation/deep-worker tasks.',
    description: 'For implementation/deep-worker tasks, use category="deep" instead of subagent_type="hephaestus".',
  },
} as const

function resolveDisabledDirectSubagentType(agentName: string): keyof typeof DISABLED_DIRECT_SUBAGENT_TYPE_MESSAGES | undefined {
  const agentConfigKey = getAgentConfigKey(agentName)
  switch (agentConfigKey) {
    case "hephaestus":
      return "hephaestus"
    default:
      return undefined
  }
}

export function isDirectSubagentTypeDisabled(agentName: string): boolean {
  return resolveDisabledDirectSubagentType(agentName) !== undefined
}

export function getDisabledDirectSubagentGuardHint(agentName: string): string | undefined {
  const disabledDirectSubagentType = resolveDisabledDirectSubagentType(agentName)
  if (disabledDirectSubagentType === undefined) return undefined
  return DISABLED_DIRECT_SUBAGENT_TYPE_MESSAGES[disabledDirectSubagentType].guard
}

function formatDisabledDirectSubagentTypeHints(): string {
  return Object.values(DISABLED_DIRECT_SUBAGENT_TYPE_MESSAGES)
    .map((message) => message.description)
    .join("\n")
}

// Kept at column 0 in the rendered section so upstream proxies (e.g. Meridian)
// can extract names via /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s.
export const BUILTIN_SUBAGENT_TYPES: readonly BuiltinSubagentType[] = [
  { name: "explore", description: "Contextual grep for codebases" },
  { name: "librarian", description: "External docs/code search via GitHub and Context7" },
  { name: "oracle", description: "Read-only consultation for architecture and hard debugging" },
  { name: "multimodal-looker", description: "PDF/image/video analysis" },
  { name: "metis", description: "Pre-planning consultant for scope clarification and ambiguity analysis" },
  { name: "momus", description: "Plan reviewer with rigorous clarity/verifiability checks" },
  { name: "sisyphus-junior", description: "Category-spawned general executor" },
] as const

export function formatAvailableAgentTypesSection(): string {
  const lines = BUILTIN_SUBAGENT_TYPES.map(
    (agent) => `- ${agent.name}: ${agent.description}`,
  )
  return `Available agent types:\n${lines.join("\n")}\n\n${formatDisabledDirectSubagentTypeHints()}`
}

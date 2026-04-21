export interface BuiltinSubagentType {
  name: string
  description: string
}

// Kept at column 0 in the rendered section so upstream proxies (e.g. Meridian)
// can extract names via /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s.
export const BUILTIN_SUBAGENT_TYPES: readonly BuiltinSubagentType[] = [
  { name: "explore", description: "Contextual grep for codebases" },
  { name: "librarian", description: "External docs/code search via GitHub and Context7" },
  { name: "oracle", description: "Read-only consultation for architecture and hard debugging" },
  { name: "hephaestus", description: "Autonomous deep worker for goal-oriented end-to-end execution" },
  { name: "multimodal-looker", description: "PDF/image/video analysis" },
  { name: "metis", description: "Pre-planning consultant for scope clarification and ambiguity analysis" },
  { name: "momus", description: "Plan reviewer with rigorous clarity/verifiability checks" },
  { name: "sisyphus-junior", description: "Category-spawned general executor" },
] as const

export function formatAvailableAgentTypesSection(): string {
  const lines = BUILTIN_SUBAGENT_TYPES.map(
    (agent) => `- ${agent.name}: ${agent.description}`,
  )
  return `Available agent types:\n${lines.join("\n")}`
}

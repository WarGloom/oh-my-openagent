import { getAgentConfigKey, getAgentDisplayName, stripAgentListSortPrefix } from "../../shared/agent-display-names"
import { loadUserAgents, loadProjectAgents } from "../../features/claude-code-agent-loader"

export type AgentMode = "subagent" | "primary" | "all" | undefined

export type AgentInfo = {
  name: string
  mode?: "subagent" | "primary" | "all"
  model?: string | { providerID: string; modelID: string }
}

const BUILTIN_AGENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  explore: ["explorer"],
}

function normalizeComparableName(name: string): string {
  return stripAgentListSortPrefix(name).trim().toLowerCase()
}

function expandBuiltinAliases(agentName: string): string[] {
  const normalized = normalizeComparableName(agentName)
  return Object.entries(BUILTIN_AGENT_ALIASES)
    .filter(([builtinName, aliases]) => normalized === builtinName || aliases.includes(normalized))
    .map(([builtinName]) => builtinName)
}

export function sanitizeSubagentType(subagentType: string): string {
  return subagentType.trim().replace(/^[\\\/"']+|[\\\/"']+$/g, "").trim()
}

export function mergeWithClaudeCodeAgents(
  serverAgents: AgentInfo[],
  directory: string | undefined,
): AgentInfo[] {
  const userAgentsRecord = loadUserAgents()
  const projectAgentsRecord = loadProjectAgents(directory)

  const toAgentInfoList = (record: Record<string, { mode?: string; model?: AgentInfo["model"] }>): AgentInfo[] =>
    Object.entries(record).map(([name, config]) => ({
      name,
      mode: config.mode as AgentInfo["mode"],
      model: config.model,
    }))

  const mergedAgentMap = new Map<string, AgentInfo>()
  const addIfAbsent = (agent: AgentInfo): void => {
    const key = agent.name.toLowerCase()
    if (!mergedAgentMap.has(key)) {
      mergedAgentMap.set(key, agent)
    }
  }

  for (const agent of serverAgents) addIfAbsent(agent)
  for (const agent of toAgentInfoList(projectAgentsRecord)) addIfAbsent(agent)
  for (const agent of toAgentInfoList(userAgentsRecord)) addIfAbsent(agent)

  return Array.from(mergedAgentMap.values())
}

function buildComparableNames(agentName: string): Set<string> {
  const aliasExpansions = expandBuiltinAliases(agentName)
  return new Set([
    agentName,
    getAgentDisplayName(agentName),
    getAgentConfigKey(agentName),
    ...aliasExpansions,
    ...aliasExpansions.map((name) => getAgentDisplayName(name)),
    ...aliasExpansions.map((name) => getAgentConfigKey(name)),
  ].map(normalizeComparableName))
}

function matchesRequestedAgent(agent: AgentInfo, requestedAgentName: string): boolean {
  const comparableNames = buildComparableNames(requestedAgentName)
  const listedAgentName = stripAgentListSortPrefix(agent.name).trim().toLowerCase()
  const listedAgentConfigKey = getAgentConfigKey(agent.name).trim().toLowerCase()

  return comparableNames.has(listedAgentName) || comparableNames.has(listedAgentConfigKey)
}

export function isTaskCallableAgentMode(mode: AgentMode): boolean {
  return mode === "all" || mode === "subagent"
}

export function findPrimaryAgentMatch(
  agents: AgentInfo[],
  requestedAgentName: string,
): AgentInfo | undefined {
  return agents.find(agent => agent.mode === "primary" && matchesRequestedAgent(agent, requestedAgentName))
}

export function findCallableAgentMatch(
  agents: AgentInfo[],
  requestedAgentName: string,
): AgentInfo | undefined {
  return agents.find(agent => isTaskCallableAgentMode(agent.mode) && matchesRequestedAgent(agent, requestedAgentName))
}

export function listCallableAgentNames(agents: AgentInfo[]): string {
  return agents
    .filter(agent => isTaskCallableAgentMode(agent.mode))
    .map(agent => stripAgentListSortPrefix(agent.name))
    .sort()
    .join(", ")
}

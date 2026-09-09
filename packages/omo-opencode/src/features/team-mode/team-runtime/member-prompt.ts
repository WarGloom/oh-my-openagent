import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { Member, RuntimeState, TeamSpec } from "../types"
import { buildTeammateCommunicationAddendum } from "../member-guidance"

// One roster entry describes a peer a member can address by name. `role` is derived
// only from existing MemberSchema / runtime-state metadata — no new persisted field.
export type MemberPromptRosterEntry = {
  readonly name: string
  readonly isLead: boolean
  readonly role?: string
}

function describeSpecMemberRole(member: TeamSpec["members"][number]): string | undefined {
  if (member.kind === "category") {
    const objective = member.prompt.replace(/\s+/g, " ").trim()
    return objective.length > 0 ? `${member.category}: ${objective}` : member.category
  }
  const objective = member.prompt?.replace(/\s+/g, " ").trim()
  return objective && objective.length > 0 ? `${member.subagent_type}: ${objective}` : member.subagent_type
}

function describeRuntimeMemberRole(member: RuntimeState["members"][number]): string | undefined {
  return member.subagent_type ?? member.category
}

export function buildTeamRosterFromSpec(spec: TeamSpec): MemberPromptRosterEntry[] {
  return spec.members.map((member) => ({
    name: member.name,
    isLead: member.name === spec.leadAgentId,
    role: describeSpecMemberRole(member),
  }))
}

export function buildTeamRosterFromRuntime(state: RuntimeState): MemberPromptRosterEntry[] {
  return state.members.map((member) => ({
    name: member.name,
    isLead: member.agentType === "leader",
    role: describeRuntimeMemberRole(member),
  }))
}

function buildRosterSection(roster: MemberPromptRosterEntry[], selfName: string): string | undefined {
  if (roster.length <= 1) return undefined

  const lines = roster.map((entry) => {
    const markers: string[] = []
    if (entry.isLead) markers.push("lead")
    if (entry.name === selfName) markers.push("you")
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : ""
    const role = entry.role ? ` — ${entry.role}` : ""
    return `- ${entry.name}${suffix}${role}`
  })

  return [
    "# Team Roster",
    "You are one member of this team. Coordinate directly with the teammates below through `team_send_message` when your work depends on theirs; the lead resolves scope, conflicts, and acceptance.",
    ...lines,
  ].join("\n")
}

// Shared by create and add so both spawn members with the same roster-aware prompt.
export function buildMemberPrompt(input: {
  readonly teamName: string
  readonly teamRunId: string
  readonly member: Pick<Member, "name"> & { readonly prompt?: string }
  readonly config: TeamModeConfig
  readonly roster: MemberPromptRosterEntry[]
  readonly worktreePath?: string
}): string {
  const promptLines = [
    `Team: ${input.teamName}`,
    `TeamRunId: ${input.teamRunId}`,
    `Member: ${input.member.name}`,
  ]
  if (input.worktreePath) promptLines.push(`Worktree: ${input.worktreePath}`)

  const rosterSection = buildRosterSection(input.roster, input.member.name)
  if (rosterSection) promptLines.push(rosterSection)

  if (input.member.prompt) promptLines.push(input.member.prompt)
  promptLines.push(buildTeammateCommunicationAddendum(input.config))
  return promptLines.join("\n")
}

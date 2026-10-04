import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import type { TeamModeConfig } from "../../config/schema/team-mode"
import { assertTeamSessionCanContinue, lookupTeamSession } from "../../features/team-mode/team-session-registry"
import type { RuntimeState } from "../../features/team-mode/types"
import { listActiveTeams, loadRuntimeState } from "../../features/team-mode/team-state-store"

const ACTIVE_RUNTIME_STATUSES = new Set<RuntimeState["status"]>(["creating", "active", "shutdown_requested"])
const UNIVERSAL_TOOL_NAMES = new Set([
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
])

type TeamParticipant =
  { role: "neither" } | { role: "lead"; teamRunId: string } | { role: "member"; teamRunId: string; memberName: string }

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

async function resolveParticipantFromRegistry(
  sessionID: string,
  config: TeamModeConfig,
): Promise<TeamParticipant | undefined> {
  const entry = lookupTeamSession(sessionID)
  if (!entry) return undefined
  const state = await loadRuntimeState(entry.teamRunId, config).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!state) return undefined
  const member = state.members.find((candidate) => candidate.name === entry.memberName)
  if (!member || member.removal || (member.sessionId !== undefined && member.sessionId !== sessionID)) return undefined
  if (entry.role === "lead") {
    return { role: "lead", teamRunId: entry.teamRunId }
  }
  return { role: "member", teamRunId: entry.teamRunId, memberName: entry.memberName }
}

async function resolveParticipant(sessionID: string, config: TeamModeConfig): Promise<TeamParticipant> {
  const fromRegistry = await resolveParticipantFromRegistry(sessionID, config)
  if (fromRegistry) {
    return fromRegistry
  }

  const activeTeams = await listActiveTeams(config)

  for (const activeTeam of activeTeams) {
    const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config)
    if (!ACTIVE_RUNTIME_STATUSES.has(runtimeState.status)) {
      continue
    }

    if (runtimeState.leadSessionId === sessionID) {
      return { role: "lead", teamRunId: runtimeState.teamRunId }
    }

    const matchedMember = runtimeState.members.find((member) => member.sessionId === sessionID)
    if (matchedMember && !matchedMember.removal) {
      return {
        role: "member",
        teamRunId: runtimeState.teamRunId,
        memberName: matchedMember.name,
      }
    }
  }

  return { role: "neither" }
}

function isLeadOfTargetTeam(participant: TeamParticipant, teamRunId: string | undefined): boolean {
  return participant.role === "lead" && participant.teamRunId === teamRunId
}

function isTargetMember(
  participant: TeamParticipant,
  teamRunId: string | undefined,
  memberName: string | undefined,
): boolean {
  return participant.role === "member" && participant.teamRunId === teamRunId && participant.memberName === memberName
}

export function createTeamToolGating(_ctx: PluginInput, config: TeamModeConfig | undefined): Hooks {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      if (!config?.enabled) {
        return
      }
      assertTeamSessionCanContinue(input.sessionID, config)

      const toolName = input.tool
      if (!toolName.startsWith("team_") && toolName !== "delegate-task") {
        return
      }

      const participant = await resolveParticipant(input.sessionID, config)

      if (toolName === "delegate-task") {
        return
      }

      if (toolName === "team_create") {
        if (participant.role !== "neither") {
          throw new Error(`team_create denied: session is already a participant of team ${participant.teamRunId}`)
        }

        return
      }

      const teamRunId = getStringArg(output.args, "teamRunId")
      const memberName = getStringArg(output.args, "memberName")

      if (
        toolName === "team_delete" ||
        toolName === "team_shutdown_request" ||
        toolName === "team_add_member" ||
        toolName === "team_remove_member"
      ) {
        if (!isLeadOfTargetTeam(participant, teamRunId)) {
          throw new Error(`${toolName} is lead-only`)
        }
        if (toolName === "team_remove_member" && teamRunId !== undefined) {
          const state = await loadRuntimeState(teamRunId, config)
          if (state.leadSessionId !== input.sessionID || state.status !== "active")
            throw new Error("team_remove_member is lead-only for an active run")
        }

        return
      }

      if (toolName === "team_approve_shutdown" || toolName === "team_reject_shutdown") {
        if (!isLeadOfTargetTeam(participant, teamRunId) && !isTargetMember(participant, teamRunId, memberName)) {
          throw new Error(`${toolName}: caller must be target member or team lead`)
        }

        return
      }

      if (toolName === "team_list") {
        return
      }

      if (UNIVERSAL_TOOL_NAMES.has(toolName)) {
        if ((participant.role === "lead" || participant.role === "member") && participant.teamRunId === teamRunId) {
          return
        }

        throw new Error(
          teamRunId === undefined
            ? `team-mode tool ${toolName} requires teamRunId argument`
            : `team-mode tool ${toolName} denied: not a participant of team ${teamRunId}`,
        )
      }
    },
  }
}

import type { MouseEvent } from "@opentui/core"

import { box, text } from "./element-helpers"
import type { ViewNode } from "./element-helpers"
import { assertNever } from "./state-types"
import type { TeamMemberRow, TeamRow, TeamsState } from "./state-types"

type ThemeLike = {
  readonly error?: unknown
  readonly text?: unknown
  readonly textMuted?: unknown
  readonly warning?: unknown
  readonly success?: unknown
  readonly info?: unknown
  readonly accent?: unknown
  readonly borderSubtle?: unknown
}

export type TeamSectionInteraction = {
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onNavigateSession: (sessionId: string) => void
}

export function teamNodes(
  teams: TeamsState,
  theme: ThemeLike,
  interaction?: TeamSectionInteraction,
): ViewNode[] {
  switch (teams.kind) {
    case "none":
      return []
    case "list":
      return [
        teamHeader(teams, theme, interaction),
        ...(interaction?.collapsed ? [] : orderedTeams(teams).flatMap((team) => orderedMembers(team).map((member) => teamMemberNode(team.name, member, theme, interaction)))),
      ]
    default:
      return assertNever(teams)
  }
}

export function teamLines(teams: TeamsState): string[] {
  switch (teams.kind) {
    case "none":
      return []
    case "list":
      return [
        `Team (${memberCount(teams)})`,
        ...orderedTeams(teams).flatMap((team) => orderedMembers(team).map((member) => `• ${teamMemberLine(team.name, member)}`)),
      ]
    default:
      return assertNever(teams)
  }
}

function teamHeader(teams: Extract<TeamsState, { readonly kind: "list" }>, theme: ThemeLike, interaction?: TeamSectionInteraction): ViewNode {
  return box(
    interaction === undefined ? {} : { onMouseDown: interaction.onToggle },
    [text({ fg: theme.text }, `Team (${memberCount(teams)}) ${interaction?.collapsed ? "▶" : "▼"}`)],
  )
}

function teamMemberNode(
  teamName: string,
  member: TeamMemberRow,
  theme: ThemeLike,
  interaction?: TeamSectionInteraction,
): ViewNode {
  const sessionId = member.sessionId
  return box({
    flexDirection: "row",
    flexWrap: "nowrap",
    gap: 1,
    height: 1,
    overflow: "hidden",
    ...(sessionId === null || interaction === undefined ? {} : {
      onMouseDown: (event: MouseEvent): void => {
        event.stopPropagation()
        interaction.onNavigateSession(sessionId)
      },
    }),
  }, [
    text({ fg: memberStatusColor(member, theme) }, "•"),
    text({ fg: theme.text, flexShrink: 0, wrapMode: "none" }, member.name),
    text({ fg: theme.textMuted, flexGrow: 1, flexShrink: 1, overflow: "hidden", truncate: true, wrapMode: "none" }, `${memberContext(teamName, member)} · `),
    text({ fg: theme.textMuted, flexShrink: 0, wrapMode: "none" }, memberStatusLabel(member)),
  ])
}

function memberCount(teams: Extract<TeamsState, { readonly kind: "list" }>): number {
  return teams.teams.reduce((count, team) => count + team.members.length, 0)
}

function teamMemberLine(teamName: string, member: TeamMemberRow): string {
  return `${member.name} ${memberContext(teamName, member)} · ${memberStatusLabel(member)}`
}

function memberContext(teamName: string, member: TeamMemberRow): string {
  return member.work ?? teamName
}

function orderedTeams(teams: Extract<TeamsState, { readonly kind: "list" }>): readonly TeamRow[] {
  return [...teams.teams].toSorted((left, right) => left.name.localeCompare(right.name))
}

function orderedMembers(team: TeamRow): readonly TeamMemberRow[] {
  return [...team.members].toSorted((left, right) => left.name.localeCompare(right.name))
}

function memberStatusColor(member: TeamMemberRow, theme: ThemeLike): unknown {
  switch (member.status) {
    case "running":
      return theme.success
    case "errored":
      return theme.error
    case "pending":
      return theme.warning
    case "idle":
    case "completed":
    case "shutdown_approved":
      return theme.textMuted
    default:
      return assertNever(member.status)
  }
}

function memberStatusLabel(member: TeamMemberRow): string {
  switch (member.status) {
    case "running":
      return "Running"
    case "errored":
      return "Errored"
    case "pending":
      return "Pending"
    case "idle":
      return "Idle"
    case "completed":
      return "Completed"
    case "shutdown_approved":
      return "Shutdown Approved"
    default:
      return assertNever(member.status)
  }
}

import { assertNever } from "./state-types"
import type { TeamRow, TeamsState } from "./state-types"

export class TeamSessionCache {
  readonly #teamsBySession = new Map<string, Map<string, TeamRow>>()
  readonly #sessionIdsByTeam = new Map<string, readonly string[]>()

  update(teams: TeamsState): void {
    switch (teams.kind) {
      case "none":
        return
      case "list":
        for (const team of teams.teams) {
          this.replaceTeam(team)
        }
        return
      default:
        return assertNever(teams)
    }
  }

  forSession(sessionId: string | null): TeamsState {
    if (sessionId === null) {
      return { kind: "none" }
    }

    const teams = this.#teamsBySession.get(sessionId)
    if (teams === undefined || teams.size === 0) {
      return { kind: "none" }
    }

    return { kind: "list", teams: [...teams.values()].toSorted(compareTeams) }
  }

  private replaceTeam(team: TeamRow): void {
    const previousSessionIds = this.#sessionIdsByTeam.get(team.name) ?? []
    for (const sessionId of previousSessionIds) {
      this.removeTeamFromSession(sessionId, team.name)
    }

    const sessionIds = teamSessionIds(team)
    for (const sessionId of sessionIds) {
      const teams = this.#teamsBySession.get(sessionId) ?? new Map<string, TeamRow>()
      teams.set(team.name, team)
      this.#teamsBySession.set(sessionId, teams)
    }
    this.#sessionIdsByTeam.set(team.name, sessionIds)
  }

  private removeTeamFromSession(sessionId: string, teamName: string): void {
    const teams = this.#teamsBySession.get(sessionId)
    if (teams === undefined) {
      return
    }

    teams.delete(teamName)
    if (teams.size === 0) {
      this.#teamsBySession.delete(sessionId)
    }
  }
}

function teamSessionIds(team: TeamRow): readonly string[] {
  return [...new Set([
    team.leadSessionId,
    ...team.members.map((member) => member.sessionId),
  ].filter((sessionId): sessionId is string => sessionId !== null))]
}

function compareTeams(left: TeamRow, right: TeamRow): number {
  return left.name.localeCompare(right.name)
}

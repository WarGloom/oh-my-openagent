import { log } from "../logger"

export type TeamRuntimeChangeListener = (teamRunId: string) => void

const listeners = new Set<TeamRuntimeChangeListener>()

export function subscribeTeamRuntimeChanges(listener: TeamRuntimeChangeListener): () => void {
  const subscription: TeamRuntimeChangeListener = (teamRunId) => listener(teamRunId)
  listeners.add(subscription)
  return () => {
    listeners.delete(subscription)
  }
}

export function publishTeamRuntimeChange(teamRunId: string): void {
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener(teamRunId)
    } catch (error) {
      log("team runtime change listener failed", {
        event: "team-runtime-change-listener-failed",
        teamRunId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

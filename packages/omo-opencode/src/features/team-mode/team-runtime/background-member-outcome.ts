import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { BackgroundTask } from "../../background-agent/types"
import { transitionRuntimeState } from "../team-state-store/store"

export type TeamBackgroundOutcome = Readonly<Pick<BackgroundTask, "id" | "sessionId" | "teamRunId" | "status" | "currentAttemptID">>

export async function reconcileTeamBackgroundOutcome(
  outcome: TeamBackgroundOutcome,
  config: TeamModeConfig,
  isCurrent: () => boolean,
): Promise<void> {
  if (outcome.status !== "error" || !outcome.teamRunId || !outcome.sessionId) return
  await transitionRuntimeState(outcome.teamRunId, (state) => {
    if (!isCurrent() || (state.status !== "active" && state.status !== "creating")) return state
    return {
      ...state,
      members: state.members.map((member) => member.sessionId === outcome.sessionId
        && (member.status === "pending" || member.status === "running" || member.status === "idle")
        ? { ...member, status: "errored" as const }
        : member),
    }
  }, config)
}

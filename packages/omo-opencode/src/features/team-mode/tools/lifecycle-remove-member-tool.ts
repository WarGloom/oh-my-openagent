import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { CategoryMemberSchema, RuntimeStateSchema } from "@oh-my-opencode/team-core/types"
import { listActiveTeams, loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { finishTeamMemberRemoval, TeamMemberRemovalError } from "../team-runtime/remove-member"
import { resolveParticipant } from "./lifecycle-participant"

const TeamRemoveMemberArgsSchema = z.object({
  teamRunId: RuntimeStateSchema.shape.teamRunId.trim(),
  memberName: CategoryMemberSchema.shape.name.trim(),
})

export class TeamRemoveMemberToolError extends Error {
  readonly stage: TeamMemberRemovalError["code"]
  readonly removalId: string | undefined
  readonly retryable: boolean

  constructor(error: TeamMemberRemovalError) {
    const retryable = error.operationId !== undefined
    super(
      `team_remove_member failed: ${JSON.stringify({ stage: error.code, removalId: error.operationId, retryable })}`,
      { cause: error },
    )
    this.name = "TeamRemoveMemberToolError"
    this.stage = error.code
    this.removalId = error.operationId
    this.retryable = retryable
  }
}

type RemovalInput = Parameters<typeof finishTeamMemberRemoval>[0]

export function createTeamRemoveMemberTool(
  config: TeamModeConfig,
  client: RemovalInput["client"],
  bgMgr: RemovalInput["bgMgr"],
): ToolDefinition {
  return tool({
    description:
      "Remove one member from an active run. Lead-only. Stop and requeue must finish before capacity is released. Preserves archived identity and resources; use a fresh name for replacements.",
    args: { teamRunId: tool.schema.string(), memberName: tool.schema.string() },
    async execute(rawArgs, context) {
      const args = TeamRemoveMemberArgsSchema.parse(rawArgs)
      try {
        const { runtimeState, participant } = await resolveParticipant(args.teamRunId, context.sessionID, config, {
          listActiveTeams,
          loadRuntimeState,
        })
        if (!context.sessionID || runtimeState.leadSessionId !== context.sessionID || participant?.role !== "lead") {
          throw new TeamMemberRemovalError("authority")
        }
        if (runtimeState.status !== "active") throw new TeamMemberRemovalError("run_not_active")
        const receipt = await finishTeamMemberRemoval({
          ...args,
          leadSessionId: context.sessionID,
          config,
          client,
          bgMgr,
        })
        return JSON.stringify({
          ...args,
          removalId: receipt.operationId,
          removed: true,
          requeuedTaskIds: receipt.requeuedTaskIds,
        })
      } catch (error) {
        if (error instanceof TeamMemberRemovalError) throw new TeamRemoveMemberToolError(error)
        throw error
      }
    },
  })
}

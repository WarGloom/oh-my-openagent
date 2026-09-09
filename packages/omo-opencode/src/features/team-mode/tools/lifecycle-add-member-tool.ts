import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { OpencodeClient } from "../../../tools/delegate-task/types"
import type { BackgroundManager } from "../../background-agent/manager"
import { addTeamMember } from "../team-runtime/add-member"
import { listActiveTeams, loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import { parseMember } from "@oh-my-opencode/team-core/types"
import { normalizeInlineMember } from "@oh-my-opencode/team-core/team-registry/team-spec-input-normalizer"
import { resolveDefaultInlineCategory, type TeamCreateExecutorConfig } from "./lifecycle-inline-spec"
import { resolveParticipant, type TeamLifecycleToolContext } from "./lifecycle-participant"

const TeamAddMemberInlineMemberToolSchema = tool.schema.object({
  name: tool.schema.string().optional().describe("Member name, kebab-case or natural text; normalized before the member is added."),
  kind: tool.schema.enum(["category", "subagent_type"]).optional().describe("Member kind. Use category for category-routed workers, or subagent_type for a specific eligible agent."),
  category: tool.schema.string().optional().describe("Required for category members unless a fallback category can be inferred. Examples: quick, deep, ultrabrain, writing, artistry."),
  subagent_type: tool.schema.string().optional().describe("Required for subagent_type members. Eligible examples: sisyphus, atlas, sisyphus-junior."),
  prompt: tool.schema.string().optional().describe("Task prompt for this member. Category members need a concrete work prompt."),
  systemPrompt: tool.schema.string().optional().describe("Legacy alias for prompt; normalized before the member is added."),
  loadSkills: tool.schema.array(tool.schema.string()).optional().describe("Optional skills to load for this member."),
  role: tool.schema.string().optional().describe("Optional natural-language role used to build a prompt when prompt is omitted."),
  description: tool.schema.string().optional().describe("Optional natural-language description used to build a prompt when prompt is omitted."),
})

type TeamAddMemberToolDeps = {
  addTeamMember: typeof addTeamMember
  listActiveTeams: typeof listActiveTeams
  loadRuntimeState: typeof loadRuntimeState
}

const defaultTeamAddMemberToolDeps: TeamAddMemberToolDeps = {
  addTeamMember,
  listActiveTeams,
  loadRuntimeState,
}

export function createTeamAddMemberTool(
  config: TeamModeConfig,
  client: OpencodeClient,
  bgMgr: BackgroundManager,
  executorConfig?: TeamCreateExecutorConfig,
  deps: TeamAddMemberToolDeps = defaultTeamAddMemberToolDeps,
): ToolDefinition {
  return tool({
    description: "Add ONE member to an ACTIVE team run. Lead-only. The run keeps its existing members, tasks, and mailboxes; the new member counts against the run's max_members cap. Returns { teamRunId, memberName, sessionId, status } only after the member's durable row, inbox, and session registry entry are ready.",
    args: {
      teamRunId: tool.schema.string().describe("The active team run to extend. Use the TeamRunId returned by team_create, not the team name."),
      member: TeamAddMemberInlineMemberToolSchema.describe("One member to add, using the same inline member shape as team_create. Example: { name: \"reviewer\", category: \"deep\", prompt: \"Review the auth changes.\" }."),
    },
    async execute(rawArgs, toolContext) {
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const leadSessionId = runtimeContext.sessionID
      if (!leadSessionId) throw new Error("team_add_member requires a tool context sessionID")

      const args = rawArgs as { teamRunId?: unknown; member?: unknown }
      const teamRunId = typeof args.teamRunId === "string" ? args.teamRunId.trim() : ""
      if (teamRunId.length === 0) throw new Error("team_add_member requires a teamRunId argument")

      const projectRoot = typeof runtimeContext.directory === "string" ? runtimeContext.directory : process.cwd()

      const { runtimeState, participant } = await resolveParticipant(teamRunId, leadSessionId, config, {
        listActiveTeams: deps.listActiveTeams,
        loadRuntimeState: deps.loadRuntimeState,
      })
      if (participant?.role !== "lead") {
        throw new Error(`team_add_member is lead-only: session ${leadSessionId} is not the lead of run ${teamRunId}.`)
      }
      if (runtimeState.status !== "active") {
        throw new Error(`team_add_member denied: run ${teamRunId} is '${runtimeState.status}', not 'active'. Members can only be added to an active run.`)
      }

      const defaultCategoryName = resolveDefaultInlineCategory(executorConfig?.userCategories)
      const normalizedMember = normalizeInlineMember(
        (args.member ?? {}) as Record<string, unknown>,
        { defaultCategoryName },
      )
      const member = parseMember(normalizedMember)

      const ctx: ExecutorContext = {
        client,
        manager: bgMgr,
        directory: projectRoot,
        userCategories: executorConfig?.userCategories,
        sisyphusJuniorModel: executorConfig?.sisyphusJuniorModel,
        agentOverrides: executorConfig?.agentOverrides,
      } as ExecutorContext

      const result = await deps.addTeamMember({
        teamRunId,
        member,
        leadSessionId,
        ctx,
        config,
        bgMgr,
        parentMessageId: runtimeContext.messageID,
      })

      return JSON.stringify(result)
    },
  })
}

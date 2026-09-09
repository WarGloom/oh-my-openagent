import { access, mkdir } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { ensureBaseDirs, getInboxDir, getTeamSpecPath, resolveBaseDir } from "../team-registry/paths"
import { createRuntimeState, listActiveTeams, loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { registerTeamSession } from "../team-session-registry"
import type { RuntimeState, TeamSpec } from "../types"
import { activateTeamLayout } from "./activate-team-layout"
import { cleanupTeamRunResources } from "./cleanup-team-run-resources"
import { buildTeamRosterFromSpec } from "./member-prompt"
import {
  createMemberWorktree,
  provisionTeamMember,
  updateMemberInRuntimeState,
  type ProvisionedMemberResource,
} from "./provision-member"
import { shouldReuseCallerLeadSession } from "../resolve-caller-team-lead"
import { sweepStaleTeamSessions } from "../team-layout-tmux/sweep-stale-team-sessions"
import { registerTeamRunForSessionCleanup } from "./session-team-run-registry"
import { assertNoUnresolvedTeamMembers, hasUnresolvedTeamMembers } from "./unresolved-team-members"

type CreateTeamRunOptions = {
  callerAgentTypeId?: string
  parentMessageID?: string
}

export class TeamRunCreateError extends Error {
  constructor(
    message: string,
    public readonly cleanupReport: {
      cancelledTaskIds: string[]
      removedLayout: boolean
      removedWorktrees: string[]
      errors: string[]
    },
    cause: Error,
  ) {
    super(`${message}: ${cause.message}`)
    this.name = "TeamRunCreateError"
    this.cause = cause
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveSpecSource(spec: TeamSpec, ctx: ExecutorContext, config: TeamModeConfig): Promise<"project" | "user"> {
  const baseDir = resolveBaseDir(config)
  if (await pathExists(getTeamSpecPath(baseDir, spec.name, "project", ctx.directory))) return "project"
  if (await pathExists(getTeamSpecPath(baseDir, spec.name, "user"))) return "user"
  return "project"
}

async function findExistingRuntime(spec: TeamSpec, leadSessionId: string, config: TeamModeConfig): Promise<RuntimeState | undefined> {
  for (const candidate of await listActiveTeams(config)) {
    if (candidate.teamName !== spec.name || (candidate.status !== "creating" && candidate.status !== "active")) continue
    const runtimeState = await loadRuntimeState(candidate.teamRunId, config).catch(() => undefined)
    if (runtimeState?.leadSessionId === leadSessionId && !hasUnresolvedTeamMembers(runtimeState.members)) return runtimeState
  }
}

export async function createTeamRun(
  spec: TeamSpec,
  leadSessionId: string,
  ctx: ExecutorContext,
  config: TeamModeConfig,
  bgMgr: BackgroundManager,
  tmuxMgr?: TmuxSessionManager,
  options?: CreateTeamRunOptions,
): Promise<RuntimeState> {
  const existingRuntime = await findExistingRuntime(spec, leadSessionId, config)
  if (existingRuntime) return existingRuntime

  const activeTeams = await listActiveTeams(config)
  const activeRunIds = new Set(activeTeams.map((t) => t.teamRunId))
  sweepStaleTeamSessions(activeRunIds).catch(() => {})

  const baseDir = resolveBaseDir(config)
  await ensureBaseDirs(baseDir)
  const reusesCallerLeadSession = shouldReuseCallerLeadSession(spec, options?.callerAgentTypeId)
  let runtimeState = await createRuntimeState(spec, leadSessionId, await resolveSpecSource(spec, ctx, config), config)
  registerTeamRunForSessionCleanup(runtimeState.teamRunId)
  if (reusesCallerLeadSession && spec.leadAgentId) {
    const callerLeadSubagentType = options?.callerAgentTypeId
    registerTeamSession(leadSessionId, {
      teamRunId: runtimeState.teamRunId,
      memberName: spec.leadAgentId,
      role: "lead",
    })
    runtimeState = await updateMemberInRuntimeState(runtimeState.teamRunId, spec.leadAgentId, (member) => ({
      ...member,
      sessionId: leadSessionId,
      status: "running",
      ...(callerLeadSubagentType ? { subagent_type: callerLeadSubagentType } : {}),
    }), config)
  }
  await Promise.all(spec.members.map((member) => mkdir(getInboxDir(baseDir, runtimeState.teamRunId, member.name), { recursive: true })))

  const deadlineAt = Date.now() + (config.max_wall_clock_minutes * 60_000)
  const resources: ProvisionedMemberResource[] = spec.members.map(() => ({}))
  const roster = buildTeamRosterFromSpec(spec)
  let createdLayout = false

  try {
    let nextMemberIndex = 0
    let failure: Error | undefined
    const workerCount = Math.min(config.max_parallel_members, spec.members.length)
    const categoryExamples = Object.keys(ctx.userCategories ?? {}).join(", ")

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!failure) {
        if (Date.now() > deadlineAt) {
          failure = new Error("team creation exceeded max_wall_clock_minutes")
          return
        }
        const memberIndex = nextMemberIndex++
        const member = spec.members[memberIndex]
        if (!member) return
        const resource = resources[memberIndex]
        if (!resource) return

        try {
          if (reusesCallerLeadSession && member.name === spec.leadAgentId) {
            if (member.worktreePath) {
              resource.worktreePath = await createMemberWorktree(member.worktreePath, ctx.directory)
              await updateMemberInRuntimeState(runtimeState.teamRunId, member.name, (currentMember) => ({
                ...currentMember,
                worktreePath: resource.worktreePath,
              }), config)
            }
            continue
          }

          await provisionTeamMember({
            teamName: spec.name,
            leadAgentName: spec.leadAgentId,
            member,
            teamRunId: runtimeState.teamRunId,
            leadSessionId,
            config,
            ctx,
            bgMgr,
            roster,
            categoryExamples,
            parentMessageId: options?.parentMessageID ?? `team-create:${runtimeState.teamRunId}:${member.name}`,
            deadlineAt,
            onResourceAcquired: (acquired) => {
              if (acquired.taskId) resource.taskId = acquired.taskId
              if (acquired.worktreePath) resource.worktreePath = acquired.worktreePath
            },
            onRuntimeStateUpdated: (updated) => {
              runtimeState = updated
            },
          })
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
          return
        }
      }
    }))

    if (failure) throw failure

    const launchedRuntimeState = await loadRuntimeState(runtimeState.teamRunId, config)
    assertNoUnresolvedTeamMembers(launchedRuntimeState.members)
    createdLayout = await activateTeamLayout(launchedRuntimeState, config, ctx.directory, tmuxMgr)

    return await transitionRuntimeState(runtimeState.teamRunId, (currentState) => ({ ...currentState, status: "active" }), config)
  } catch (error) {
    const cleanupReport = await cleanupTeamRunResources({
      teamRunId: runtimeState.teamRunId,
      config,
      resources,
      bgMgr,
      tmuxMgr,
      createdLayout,
    })
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new TeamRunCreateError(`Failed to create team run '${spec.name}'`, cleanupReport, cause)
  }
}

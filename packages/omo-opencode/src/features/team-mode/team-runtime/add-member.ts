import { rmdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundManager } from "../../background-agent/manager"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import { transitionRuntimeState } from "../team-state-store/store"
import {
  admitAddedMember,
  isClaimStillOwned,
  type AdmittedMemberClaim,
} from "@oh-my-opencode/team-core/team-state-store/member-admission"
import { unregisterTeamSession } from "../team-session-registry"
import type { Member, RuntimeState } from "../types"
import { buildTeamRosterFromRuntime } from "./member-prompt"
import { createMemberWorktree, provisionTeamMember, type ProvisionedMemberResource } from "./provision-member"

export class TeamAddMemberError extends Error {
  constructor(public readonly memberName: string, cause: Error) {
    super(`Failed to add member '${memberName}': ${cause.message}`)
    this.name = "TeamAddMemberError"
    this.cause = cause
  }
}

export type AddTeamMemberResult = {
  teamRunId: string
  memberName: string
  sessionId: string
  status: RuntimeState["members"][number]["status"]
}

// Roll back ONLY resources this addition owns: its launched task, a worktree it
// created, its still-owned pending row, and its own session registry entry. Never
// cancels another member's task and never removes a pre-existing worktree.
async function rollbackOwnedAddition(input: {
  teamRunId: string
  claim: AdmittedMemberClaim
  resource: ProvisionedMemberResource
  bgMgr: BackgroundManager
  config: TeamModeConfig
  createdDirectories: string[]
}): Promise<void> {
  const errors: unknown[] = []
  if (input.resource.taskId) {
    await input.bgMgr.cancelTask(input.resource.taskId, {
      source: "team-add-rollback",
      reason: "add_rollback",
      skipNotification: true,
    }).catch((error: unknown) => { errors.push(error) })
    const task = input.bgMgr.getTask(input.resource.taskId)
    if (!task || !(task.status === "completed" || task.status === "error" || task.status === "cancelled" || task.status === "interrupt")) {
      throw new AggregateError([...errors, new Error(`task ${input.resource.taskId} has not been proven stopped`)], "addition rollback incomplete")
    }
  } else if (input.resource.sessionId) {
    throw new Error("addition rollback incomplete: acquired session has no task stop proof")
  }

  for (const directory of [...input.createdDirectories].reverse()) {
    await rmdir(directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      errors.push(error)
    })
  }

  await transitionRuntimeState(input.teamRunId, (state) => {
    const owned = state.members.some(
      (member) => member.name === input.claim.memberName && member.provisioningClaimId === input.claim.claimId,
    )
    if (!owned) return state
    return {
      ...state,
      members: state.members.filter(
        (member) => !(member.name === input.claim.memberName && member.provisioningClaimId === input.claim.claimId),
      ),
    }
  }, input.config).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    errors.push(error)
  })

  if (input.resource.sessionId) unregisterTeamSession(input.resource.sessionId)
  if (errors.length > 0) throw new AggregateError(errors, "addition rollback incomplete")
}

// Orchestrates a single add: locked admission claim -> provisioning outside the lock
// -> guarded final commit (inside provisionTeamMember). Any failure rolls back only
// this addition's owned resources and leaves the run active and usable.
export async function addTeamMember(input: {
  teamRunId: string
  member: Member
  leadSessionId: string
  ctx: ExecutorContext
  config: TeamModeConfig
  bgMgr: BackgroundManager
  parentMessageId?: string
}): Promise<AddTeamMemberResult> {
  const { teamRunId, member, config, bgMgr } = input
  const claimId = randomUUID()
  const baseDir = resolveBaseDir(config)

  // 1. Atomic locked claim. Throws MemberAdmissionError (capacity / duplicate name /
  //    run not active) without mutating state; two concurrent adds are serialized here.
  const claimedState = await transitionRuntimeState(teamRunId, (state) => {
    const { member: pendingMember } = admitAddedMember(state, member.name, claimId)
    return { ...state, members: [...state.members, pendingMember] }
  }, config)
  const claim: AdmittedMemberClaim = { memberName: member.name, claimId }

  // 2. Provision outside the lock.
  const resource: ProvisionedMemberResource = {}
  const createdDirectories: string[] = []
  let finalMember: RuntimeState["members"][number] | undefined

  try {
    await createMemberWorktree(getInboxDir(baseDir, teamRunId, member.name), input.ctx.directory, (directory) => createdDirectories.push(directory))
    await provisionTeamMember({
      teamName: claimedState.teamName,
      leadAgentName: claimedState.members.find((candidate) => candidate.agentType === "leader")?.name,
      member,
      teamRunId,
      leadSessionId: input.leadSessionId,
      config,
      ctx: input.ctx,
      bgMgr,
      roster: buildTeamRosterFromRuntime(claimedState),
      categoryExamples: Object.keys(input.ctx.userCategories ?? {}).join(", "),
      parentMessageId: input.parentMessageId ?? `team-add:${teamRunId}:${member.name}`,
      deadlineAt: Date.now() + (claimedState.bounds.maxWallClockMinutes * 60_000),
      commitGuard: (state) => isClaimStillOwned(state, claim),
      onResourceAcquired: (acquired) => {
        if (acquired.taskId) resource.taskId = acquired.taskId
        if (acquired.worktreePath) resource.worktreePath = acquired.worktreePath
        if (acquired.sessionId) resource.sessionId = acquired.sessionId
        if (acquired.createdDirectory) createdDirectories.push(acquired.createdDirectory)
      },
      onRuntimeStateUpdated: (state) => {
        finalMember = state.members.find((candidate) => candidate.name === member.name)
      },
    })
    if (!finalMember || finalMember.sessionId === undefined) throw new Error("member row missing or unresolved after provisioning")
    return { teamRunId, memberName: member.name, sessionId: finalMember.sessionId, status: finalMember.status }
  } catch (error) {
    try {
      await rollbackOwnedAddition({ teamRunId, claim, resource, bgMgr, config, createdDirectories })
    } catch (rollbackError) {
      throw new TeamAddMemberError(member.name, new AggregateError([error, rollbackError], "provisioning failed and rollback incomplete"))
    }
    throw new TeamAddMemberError(member.name, error instanceof Error ? error : new Error(String(error)))
  }

}

import { mkdir, stat } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { DelegatedModelConfig } from "../../../shared/model-resolution-types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../../shared/question-denied-session-permission"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundManager } from "../../background-agent/manager"
import type { BackgroundTask } from "../../background-agent/types"
import { registerTeamSession } from "../team-session-registry"
import { transitionRuntimeState } from "../team-state-store/store"
import type { Member, RuntimeState } from "../types"
import { buildMemberPrompt, type MemberPromptRosterEntry } from "./member-prompt"
import { resolveMember } from "./resolve-member"

export const SESSION_ID_POLL_MS = 25

export class MemberProvisionClaimLostError extends Error {
  constructor(public readonly memberName: string, teamRunId: string) {
    super(`provisioning ownership lost for member '${memberName}' in run ${teamRunId}`)
    this.name = "MemberProvisionClaimLostError"
  }
}

export type ProvisionedMemberResource = {
  taskId?: string
  worktreePath?: string
  sessionId?: string
  createdDirectory?: string
}

export async function createMemberWorktree(memberWorktreePath: string, projectRoot: string, onCreated?: (directory: string) => void): Promise<string> {
  const absolutePath = path.isAbsolute(memberWorktreePath) ? memberWorktreePath : path.resolve(projectRoot, memberWorktreePath)
  try {
    await mkdir(absolutePath)
    onCreated?.(absolutePath)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error
    if (error.code === "ENOENT") {
      await createMemberWorktree(path.dirname(absolutePath), projectRoot, onCreated)
      return createMemberWorktree(absolutePath, projectRoot, onCreated)
    }
    if (error.code !== "EEXIST" || !(await stat(absolutePath)).isDirectory()) throw error
  }
  return absolutePath
}

export function toPersistedMemberModel(model: DelegatedModelConfig | undefined): RuntimeState["members"][number]["model"] | undefined {
  if (!model) return undefined
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { top_p: model.top_p } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
  }
}

export async function waitForTaskSessionId(bgMgr: BackgroundManager, task: BackgroundTask, deadlineAt: number): Promise<string> {
  while (true) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for child session for task ${task.id}`)
    const updatedTask = bgMgr.getTask(task.id) ?? task
    if (!updatedTask.sessionId && (updatedTask.status === "error" || updatedTask.status === "cancelled" || updatedTask.status === "interrupt" || updatedTask.status === "completed")) {
      throw new Error(updatedTask.error ?? `task ${task.id} failed before session creation`)
    }
    if (updatedTask.sessionId) return updatedTask.sessionId
    await new Promise((resolve) => setTimeout(resolve, SESSION_ID_POLL_MS))
  }
}

export async function updateMemberInRuntimeState(
  teamRunId: string,
  memberName: string,
  patch: (member: RuntimeState["members"][number]) => RuntimeState["members"][number],
  config: TeamModeConfig,
): Promise<RuntimeState> {
  return transitionRuntimeState(teamRunId, (currentState) => ({
    ...currentState,
    members: currentState.members.map((member) =>
      member.name === memberName ? patch(member) : member,
    ),
  }), config)
}

export type ProvisionTeamMemberInput = {
  readonly teamName: string
  readonly leadAgentName?: string
  readonly member: Member
  readonly teamRunId: string
  readonly leadSessionId: string
  readonly config: TeamModeConfig
  readonly ctx: ExecutorContext
  readonly bgMgr: BackgroundManager
  readonly roster: MemberPromptRosterEntry[]
  readonly categoryExamples: string
  readonly parentMessageId: string
  readonly deadlineAt: number
  // create passes none (always commit). add passes a claim-ownership guard so a
  // concurrent delete or a lost claim aborts the final running commit and rolls back.
  readonly commitGuard?: (currentState: RuntimeState) => boolean
  readonly onResourceAcquired?: (resource: ProvisionedMemberResource) => void
  readonly onRuntimeStateUpdated?: (state: RuntimeState) => void
}

export type ProvisionedMember = {
  readonly taskId: string
  readonly sessionId: string
  readonly resolvedAgent: string
  readonly worktreePath?: string
}

// Per-member provisioning shared by create and add. Runs OUTSIDE the admission lock:
// worktree, member resolution, background session spawn, registry publish, and the
// final durable running commit. The final commit is guard-checked so a lost claim
// throws MemberProvisionClaimLostError instead of registering a stale success.
export async function provisionTeamMember(input: ProvisionTeamMemberInput): Promise<ProvisionedMember> {
  const role = input.member.name === input.leadAgentName ? "lead" : "member"
  let committed = false
  let publishedSessionId: string | undefined
  const assertPublicationOwned = (state: RuntimeState): void => {
    if (!input.commitGuard || input.commitGuard(state)) return
    const member = state.members.find((candidate) => candidate.name === input.member.name)
    if (committed && state.status === "active" && member?.sessionId === publishedSessionId) return
    throw new MemberProvisionClaimLostError(input.member.name, input.teamRunId)
  }

  const worktreePath = input.member.worktreePath
    ? await createMemberWorktree(input.member.worktreePath, input.ctx.directory, (createdDirectory) => input.onResourceAcquired?.({ createdDirectory }))
    : undefined
  if (worktreePath) input.onResourceAcquired?.({ worktreePath })

  const resolvedMember = await resolveMember(input.member, input.ctx, input.categoryExamples, input.leadAgentName)
  const memberGoal = input.member.prompt?.replace(/\s+/g, " ").trim()

  input.ctx.abortSignal?.throwIfAborted()
  const task = await input.bgMgr.launch({
    description: memberGoal ? `${input.member.name}: ${memberGoal}` : input.member.name,
    prompt: buildMemberPrompt({
      teamName: input.teamName,
      teamRunId: input.teamRunId,
      member: input.member,
      config: input.config,
      roster: input.roster,
      worktreePath,
    }),
    agent: resolvedMember.agentToUse,
    parentSessionId: input.leadSessionId,
    parentMessageId: input.parentMessageId,
    teamRunId: input.teamRunId,
    suppressTmuxSpawn: true,
    model: resolvedMember.model,
    fallbackChain: resolvedMember.fallbackChain,
    skillContent: resolvedMember.systemContent,
    category: input.member.kind === "category" ? input.member.category : undefined,
    sessionPermission: QUESTION_DENIED_SESSION_PERMISSION,
    ...(worktreePath ? { cwd: worktreePath } : {}),
    onSessionCreated: async (sessionId, sessionModel) => {
      input.onResourceAcquired?.({ sessionId })
      const persistedSessionModel = toPersistedMemberModel(sessionModel)
      if (!input.commitGuard) registerTeamSession(sessionId, { teamRunId: input.teamRunId, memberName: input.member.name, role })
      const updated = await transitionRuntimeState(input.teamRunId, (state) => {
        assertPublicationOwned(state)
        registerTeamSession(sessionId, { teamRunId: input.teamRunId, memberName: input.member.name, role })
        publishedSessionId = sessionId
        return { ...state, members: state.members.map((member) => member.name === input.member.name ? {
          ...member,
          sessionId,
          status: member.status === "pending" || member.status === "idle" || (committed && member.status === "errored") ? "running" : member.status,
          ...(persistedSessionModel ? { model: persistedSessionModel } : {}),
        } : member) }
      }, input.config)
      input.onRuntimeStateUpdated?.(updated)
    },
  })
  input.onResourceAcquired?.({ taskId: task.id })

  let sessionId = await waitForTaskSessionId(input.bgMgr, task, input.deadlineAt)
  input.onResourceAcquired?.({ sessionId })

  const persistedModel = toPersistedMemberModel(resolvedMember.model)
  const updated = await transitionRuntimeState(input.teamRunId, (currentState) => {
    assertPublicationOwned(currentState)
    const currentTask = input.bgMgr.getTask(task.id) ?? task
    const currentMember = currentState.members.find((member) => member.name === input.member.name)
    sessionId = currentMember?.sessionId ?? currentTask.sessionId ?? sessionId
    registerTeamSession(sessionId, { teamRunId: input.teamRunId, memberName: input.member.name, role })
    publishedSessionId = sessionId
    return {
      ...currentState,
      members: currentState.members.map((member) =>
        member.name === input.member.name
          ? {
              ...member,
              sessionId,
              status: member.status !== "pending" && member.status !== "running" && member.status !== "idle"
                ? member.status
                : currentTask.sessionId === sessionId && currentTask.status === "error" ? "errored" : "running",
              worktreePath,
              subagent_type: resolvedMember.agentToUse,
              provisioningClaimId: undefined,
              ...(input.member.kind === "category" ? { category: input.member.category } : {}),
              ...(member.sessionId === sessionId && member.model
                ? { model: member.model }
                : persistedModel ? { model: persistedModel } : {}),
            }
          : member,
      ),
    }
  }, input.config)
  committed = true
  input.onResourceAcquired?.({ sessionId })
  input.onRuntimeStateUpdated?.(updated)

  return { taskId: task.id, sessionId, resolvedAgent: resolvedMember.agentToUse, worktreePath }
}

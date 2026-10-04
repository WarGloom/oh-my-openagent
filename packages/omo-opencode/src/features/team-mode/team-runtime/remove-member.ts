import { randomUUID } from "node:crypto"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { MemberRemoval, RemovedMember } from "@oh-my-opencode/team-core/types"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { requeueMemberTasks } from "@oh-my-opencode/team-core/team-tasklist/requeue"
import { configureTeamSessionRemoval, denyTeamSession } from "../team-session-registry"
import { fenceInternalPrompts } from "../../../shared/prompt-async-gate"
import { withDispatchTimeout } from "@oh-my-opencode/utils/prompt-async-gate/timing"
import { abortWithTimeout, type AbortSessionClient } from "../../background-agent/abort-with-timeout"
import type { BackgroundTask } from "../../background-agent/types"
import { extractErrorStatusCode } from "../../background-agent/error-classifier"

export class TeamMemberRemovalError extends Error {
  constructor(
    public readonly code: "authority" | "run_not_active" | "lead" | "unknown" | "provisioning" | "unresolved" | "stop_unverified" | "requeue_failed" | "publication_failed",
    public readonly operationId?: string,
    options?: ErrorOptions,
  ) {
    super(`team member removal: ${code}`, options)
    this.name = "TeamMemberRemovalError"
  }
}

export async function finishTeamMemberRemoval(input: Parameters<typeof stopTeamMemberRemoval>[0]): Promise<RemovedMember> {
  const initial = await loadRuntimeState(input.teamRunId, input.config)
  if (!initial.leadSessionId || initial.leadSessionId !== input.leadSessionId) throw new TeamMemberRemovalError("authority")
  const completed = initial.removedMembers?.find(record => record.member.name === input.memberName)
  if (completed) return completed
  const removal = await stopTeamMemberRemoval(input)
  let stage: "requeue_failed" | "publication_failed" = "requeue_failed"
  try {
    await transitionRuntimeState(input.teamRunId, current => {
      const member = current.members.find(row => row.name === input.memberName)
      if (current.status !== "active" || current.leadSessionId !== input.leadSessionId
        || member?.sessionId !== removal.sessionId || member.removal?.operationId !== removal.operationId || member.removal.phase === "fenced") {
        throw new TeamMemberRemovalError("requeue_failed", removal.operationId)
      }
      return { ...current, members: current.members.map(row => row.name === input.memberName
        ? { ...row, removal: { ...removal, phase: "requeueing" as const } } : row) }
    }, input.config)
    const taskIds = await requeueMemberTasks({ ...input, removal })
    stage = "publication_failed"
    const published = await transitionRuntimeState(input.teamRunId, current => {
      if (current.status !== "active" || current.leadSessionId !== input.leadSessionId) throw new TeamMemberRemovalError(stage, removal.operationId)
      if (current.removedMembers?.some(record => record.operationId === removal.operationId)) return current
      const member = current.members.find(row => row.name === input.memberName)
      if (member?.sessionId !== removal.sessionId || member.removal?.sessionId !== removal.sessionId
        || member.removal.operationId !== removal.operationId || member.removal.phase !== "requeueing") {
        throw new TeamMemberRemovalError(stage, removal.operationId)
      }
      return { ...current, members: current.members.filter(row => row.name !== input.memberName), removedMembers: [
        ...current.removedMembers ?? [],
        { member: { ...member, removal: { ...member.removal, taskIds } }, operationId: removal.operationId, removedAt: Date.now(), requeuedTaskIds: taskIds },
      ] }
    }, input.config)
    const receipt = published.removedMembers?.find(record => record.operationId === removal.operationId)
    if (!receipt) throw new TeamMemberRemovalError(stage, removal.operationId)
    return receipt
  } catch (error) {
    const state = await loadRuntimeState(input.teamRunId, input.config)
    const receipt = state.removedMembers?.find(record => record.operationId === removal.operationId && record.member.sessionId === removal.sessionId)
    if (receipt && state.leadSessionId === input.leadSessionId) return receipt
    if (error instanceof TeamMemberRemovalError) throw error
    throw new TeamMemberRemovalError(stage, removal.operationId, { cause: error })
  }
}

export type BeginTeamMemberRemovalInput = {
  readonly teamRunId: string
  readonly memberName: string
  readonly leadSessionId: string
  readonly config: TeamModeConfig
}

export async function beginTeamMemberRemoval(input: BeginTeamMemberRemovalInput): Promise<MemberRemoval> {
  const state = await transitionRuntimeState(input.teamRunId, current => {
    if (!current.leadSessionId || current.leadSessionId !== input.leadSessionId) throw new TeamMemberRemovalError("authority")
    if (current.status !== "active") throw new TeamMemberRemovalError("run_not_active")
    const member = current.members.find(candidate => candidate.name === input.memberName)
    if (!member) throw new TeamMemberRemovalError("unknown")
    if (member.sessionId === current.leadSessionId) throw new TeamMemberRemovalError("lead")
    if (member.provisioningClaimId) throw new TeamMemberRemovalError("provisioning")
    if (!member.sessionId) throw new TeamMemberRemovalError("unresolved")
    const lead = current.members.find(candidate => candidate.sessionId === current.leadSessionId)
    if (!lead) throw new TeamMemberRemovalError("authority")
    const removal = member.removal ?? {
      operationId: randomUUID(), sessionId: member.sessionId, startedAt: Date.now(), phase: "fenced" as const, taskIds: [],
    }
    if (removal.sessionId !== member.sessionId) throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
    return { ...current, members: current.members.map(candidate => candidate.name === member.name
      ? { ...candidate, removal }
      : candidate.name === lead.name ? { ...candidate, removalProtocolVersion: 1 as const } : candidate) }
  }, input.config)
  const removal = state.members.find(member => member.name === input.memberName)?.removal
  if (!removal) throw new TeamMemberRemovalError("stop_unverified")
  configureTeamSessionRemoval(input.config)
  denyTeamSession(removal.sessionId)
  return removal
}

type RemovalTask = Pick<BackgroundTask, "id" | "sessionId" | "status">
type RemovalBackgroundManager = {
  readonly findBySession: (sessionId: string) => RemovalTask | undefined
  readonly getTask: (taskId: string) => RemovalTask | undefined
  readonly cancelTask: (taskId: string, options: { source: string; abortSession: true; skipNotification: true }) => Promise<boolean>
}

export async function stopTeamMemberRemoval(input: BeginTeamMemberRemovalInput & {
  readonly client: AbortSessionClient
  readonly bgMgr: RemovalBackgroundManager
  readonly stopTimeoutMs?: number
}): Promise<MemberRemoval> {
  const removal = await beginTeamMemberRemoval(input)
  const timeoutMs = input.stopTimeoutMs ?? 10_000
  try {
    await withDispatchTimeout(fenceInternalPrompts(removal.sessionId), timeoutMs, "team removal dispatch drain")
    const task = input.bgMgr.findBySession(removal.sessionId)
    if (task && task.sessionId !== removal.sessionId) throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
    const wasRunning = task?.status === "running"
    if (task && (wasRunning || task.status === "pending")) {
      await withDispatchTimeout(input.bgMgr.cancelTask(task.id, {
        source: "team-remove-member", abortSession: true, skipNotification: true,
      }), timeoutMs, "team removal cancellation")
      const stopped = input.bgMgr.getTask(task.id)
      if (!stopped || stopped.sessionId !== removal.sessionId || stopped.status === "running" || stopped.status === "pending") {
        throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
      }
    }
    const abortClient: AbortSessionClient = { session: { abort: async request => {
      try {
        const response = await input.client.session.abort(request)
        const error = typeof response === "object" && response !== null && "error" in response ? response.error : undefined
        if (extractErrorStatusCode(error) === 404 || extractErrorStatusCode(response) === 404) return undefined
        if (response === false || (typeof response === "object" && response !== null && "data" in response && response.data === false)) {
          throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
        }
        return response
      } catch (error) {
        if (extractErrorStatusCode(error) === 404) return undefined
        throw error
      }
    } } }
    if (!await abortWithTimeout(abortClient, removal.sessionId, timeoutMs)) {
      throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
    }
    const state = await transitionRuntimeState(input.teamRunId, current => {
      const member = current.members.find(candidate => candidate.name === input.memberName)
      const currentRemoval = member?.removal
      if (current.status !== "active" || current.leadSessionId !== input.leadSessionId
        || member?.sessionId !== removal.sessionId || !currentRemoval || currentRemoval.operationId !== removal.operationId) {
        throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
      }
      const stoppedRemoval: MemberRemoval = { ...currentRemoval, phase: currentRemoval.phase === "requeueing" ? "requeueing" : "stopped" }
      return { ...current, members: current.members.map(candidate => candidate.name === input.memberName
        ? { ...candidate, removal: stoppedRemoval }
        : candidate) }
    }, input.config)
    const stopped = state.members.find(member => member.name === input.memberName)?.removal
    if (!stopped) throw new TeamMemberRemovalError("stop_unverified", removal.operationId)
    return stopped
  } catch (error) {
    if (error instanceof TeamMemberRemovalError) throw error
    throw new TeamMemberRemovalError("stop_unverified", removal.operationId, { cause: error })
  }
}

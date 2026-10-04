import type { Task } from "../types"
import { z } from "zod"
import type { TeamModeConfig } from "../config"
import { loadRuntimeState } from "../team-state-store/store"

export const REMOVAL_METADATA_KEY = "omo.team-member-removal"
export const TaskRemovalMetadataSchema = z.object({
  hold: z.uuid(),
  audits: z.record(z.uuid(), z.object({
    priorOwner: z.string(),
    priorStatus: z.enum(["claimed", "in_progress"]),
    priorClaimedAt: z.number().optional(),
    requeuedAt: z.number(),
  }).strict()),
}).strict()

export class TaskRemovalHoldError extends Error {
  constructor(public readonly operationId?: string) {
    super("task unavailable during member removal")
    this.name = "TaskRemovalHoldError"
  }
}

export function getTaskRemovalMetadata(task: Task): z.infer<typeof TaskRemovalMetadataSchema> | undefined {
  const value = task.metadata?.[REMOVAL_METADATA_KEY]
  return value === undefined ? undefined : TaskRemovalMetadataSchema.parse(value)
}

export async function assertTaskMutationAllowed(
  input: { readonly teamRunId: string; readonly memberName: string; readonly task: Task },
  config: TeamModeConfig,
): Promise<void> {
  const removal = getTaskRemovalMetadata(input.task)
  const state = await loadRuntimeState(input.teamRunId, config).catch(error => {
    if (!removal && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!state) return
  if (removal && !state.removedMembers?.some(record => record.operationId === removal.hold)) {
    throw new TaskRemovalHoldError(removal.hold)
  }
  const member = state.members.find(candidate => candidate.name === input.memberName)
  if (member?.removal || state.removedMembers?.some(record => record.member.name === input.memberName)) {
    throw new TaskRemovalHoldError(member?.removal?.operationId)
  }
}

export function canClaim(task: Task, allTasks: Task[]): boolean {
  return task.blockedBy.every((blockerId) => {
    const blockerTask = allTasks.find((candidateTask) => candidateTask.id === blockerId)
    return blockerTask === undefined || blockerTask.status === "completed"
  })
}

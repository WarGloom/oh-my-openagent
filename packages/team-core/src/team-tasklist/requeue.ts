import type { TeamModeConfig } from "../config"
import type { MemberRemoval } from "../types"
import { TaskSchema } from "../types"
import { getTaskClaimLockPath, getTaskFilePath, resolveBaseDir } from "../team-registry"
import { atomicWrite, withLock } from "../team-state-store/locks"
import { loadRuntimeState } from "../team-state-store/store"
import { getTaskRemovalMetadata, REMOVAL_METADATA_KEY, TaskRemovalHoldError } from "./dependencies"
import { getTask } from "./get"
import { listTasks } from "./list"

export type MemberTaskRequeueInput = {
  readonly teamRunId: string
  readonly memberName: string
  readonly removal: MemberRemoval
  readonly config: TeamModeConfig
}

export async function requeueMemberTasks(input: MemberTaskRequeueInput): Promise<string[]> {
  const base = resolveBaseDir(input.config)
  const ids: string[] = []
  for (const candidate of await listTasks(input.teamRunId, input.config)) {
    const requeued = await withLock(
      getTaskClaimLockPath(base, input.teamRunId, candidate.id),
      async () => {
        const state = await loadRuntimeState(input.teamRunId, input.config)
        const member = state.members.find((row) => row.name === input.memberName)
        if (
          state.status !== "active" ||
          member?.sessionId !== input.removal.sessionId ||
          member.removal?.operationId !== input.removal.operationId ||
          member.removal.sessionId !== input.removal.sessionId ||
          member.removal.phase === "fenced"
        ) {
          throw new TaskRemovalHoldError(input.removal.operationId)
        }
        const task = await getTask(input.teamRunId, candidate.id, input.config)
        const metadata = getTaskRemovalMetadata(task)
        if (metadata?.audits[input.removal.operationId]) return true
        if (task.owner !== input.memberName || (task.status !== "claimed" && task.status !== "in_progress"))
          return false
        if (metadata && !state.removedMembers?.some((record) => record.operationId === metadata.hold)) {
          throw new TaskRemovalHoldError(metadata.hold)
        }
        const now = Date.now()
        const { owner, claimedAt, ...preserved } = task
        const updated = TaskSchema.parse({
          ...preserved,
          status: "pending",
          updatedAt: now,
          metadata: {
            ...task.metadata,
            [REMOVAL_METADATA_KEY]: {
              hold: input.removal.operationId,
              audits: {
                ...metadata?.audits,
                [input.removal.operationId]: {
                  priorOwner: owner,
                  priorStatus: task.status,
                  priorClaimedAt: claimedAt,
                  requeuedAt: now,
                },
              },
            },
          },
        })
        await atomicWrite(getTaskFilePath(base, input.teamRunId, task.id), `${JSON.stringify(updated, null, 2)}\n`)
        return true
      },
      { ownerTag: `member-removal:${input.removal.operationId}` },
    )
    if (requeued) ids.push(candidate.id)
  }
  return ids
}

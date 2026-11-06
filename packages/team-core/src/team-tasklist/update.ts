import type { TeamModeConfig } from "../config"
import { getTaskClaimLockPath, getTaskFilePath, resolveBaseDir } from "../team-registry"
import { publishTeamRuntimeChange } from "../team-state-store/changes"
import { atomicWrite, withLock } from "../team-state-store/locks"
import { TaskSchema } from "../types"
import type { Task } from "../types"
import { claimTask } from "./claim"
import { getTask } from "./get"
import { assertTaskMutationAllowed } from "./dependencies"

const ALLOWED_TRANSITIONS: Readonly<Record<Task["status"], ReadonlyArray<Task["status"]>>> = {
  pending: ["claimed", "deleted"],
  claimed: ["in_progress", "deleted"],
  in_progress: ["completed", "deleted"],
  completed: ["deleted"],
  deleted: [],
}

function isValidTransition(currentStatus: Task["status"], nextStatus: Task["status"]): boolean {
  if (currentStatus === nextStatus) return true
  return ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)
}

export class InvalidTaskTransitionError extends Error {
  constructor(currentStatus: Task["status"], nextStatus: Task["status"]) {
    super(`no reverse transitions from ${currentStatus} to ${nextStatus}`)
    this.name = "InvalidTaskTransitionError"
  }
}

export class CrossOwnerUpdateError extends Error {
  constructor(message = "cross-owner updates are not allowed") {
    super(message)
    this.name = "CrossOwnerUpdateError"
  }
}

export async function updateTaskStatus(
  teamRunId: string,
  taskId: string,
  newStatus: Task["status"],
  memberName: string,
  config: TeamModeConfig,
): Promise<Task> {
  const task = await getTask(teamRunId, taskId, config)

  await assertTaskMutationAllowed({ teamRunId, memberName, task }, config)

  if (task.status === "pending" && newStatus === "in_progress") {
    await claimTask(teamRunId, taskId, memberName, config)
    return updateTaskStatus(teamRunId, taskId, newStatus, memberName, config)
  }

  if ((task.status === "pending" || task.status === "claimed") && newStatus === "completed") {
    await updateTaskStatus(teamRunId, taskId, "in_progress", memberName, config)
    return updateTaskStatus(teamRunId, taskId, newStatus, memberName, config)
  }

  return withLock(getTaskClaimLockPath(resolveBaseDir(config), teamRunId, taskId), async () => {
    const refreshedTask = await getTask(teamRunId, taskId, config)
    await assertTaskMutationAllowed({ teamRunId, memberName, task: refreshedTask }, config)
    if (refreshedTask.status === newStatus) return refreshedTask
    if (!isValidTransition(refreshedTask.status, newStatus)) {
      throw new InvalidTaskTransitionError(refreshedTask.status, newStatus)
    }
    if (newStatus !== "deleted" && refreshedTask.owner !== memberName) throw new CrossOwnerUpdateError()
    const updatedTask = TaskSchema.parse({ ...refreshedTask, status: newStatus, updatedAt: Date.now() })
    await atomicWrite(getTaskFilePath(resolveBaseDir(config), teamRunId, taskId), `${JSON.stringify(updatedTask, null, 2)}\n`)
    publishTeamRuntimeChange(teamRunId)
    return updatedTask
  }, { ownerTag: memberName })
}

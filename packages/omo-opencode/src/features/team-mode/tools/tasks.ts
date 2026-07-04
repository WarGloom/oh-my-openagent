import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { OpencodeClient } from "../../../tools/delegate-task/types"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { createTask, getTask, listTasks, updateTaskStatus, claimTask } from "@oh-my-opencode/team-core/team-tasklist"
import type { RuntimeState, Task } from "@oh-my-opencode/team-core/types"

type TeamTaskToolContext = ToolContext & {
  sessionID?: string
}

type TeamTaskListFilter = {
  status?: "pending" | "claimed" | "in_progress" | "completed" | "deleted"
  owner?: string
}

type TeamTaskCreateArgs = {
  teamRunId: string
  subject: string
  description: string
  blockedBy?: string[]
}

type TeamTaskListArgs = {
  teamRunId: string
  status?: TeamTaskListFilter["status"]
  owner?: string
}

type TeamTaskUpdateArgs = {
  teamRunId: string
  taskId: string
  status: "pending" | "claimed" | "in_progress" | "completed" | "deleted"
}

type TeamTaskGetArgs = {
  teamRunId: string
  taskId: string
}

type TeamTaskToolDeps = {
  loadRuntimeState: typeof loadRuntimeState
  createTask: typeof createTask
  listTasks: typeof listTasks
  claimTask: typeof claimTask
  updateTaskStatus: typeof updateTaskStatus
  getTask: typeof getTask
}

function normalizeTaskReference(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function rejectUnsafeTaskReference(taskReference: string): void {
  const trimmedTaskReference = taskReference.trim()
  if (
    trimmedTaskReference.length === 0 ||
    trimmedTaskReference === "." ||
    trimmedTaskReference === ".." ||
    trimmedTaskReference.includes("/") ||
    trimmedTaskReference.includes("\\") ||
    trimmedTaskReference.includes("\0")
  ) {
    throw new Error("team task reference is invalid")
  }
}

async function resolveTaskId(teamRunId: string, taskReference: string, config: TeamModeConfig, deps: TeamTaskToolDeps): Promise<string> {
  const trimmedTaskReference = taskReference.trim()
  rejectUnsafeTaskReference(trimmedTaskReference)
  if (/^\d+$/.test(trimmedTaskReference)) return trimmedTaskReference

  const normalizedReference = normalizeTaskReference(trimmedTaskReference)
  if (normalizedReference.length === 0) {
    throw new Error("team task reference is invalid")
  }
  const tasks = await deps.listTasks(teamRunId, config)
  const matches = tasks.filter((candidateTask) =>
    candidateTask.id === trimmedTaskReference ||
    candidateTask.subject === trimmedTaskReference ||
    normalizeTaskReference(candidateTask.subject) === normalizedReference
  )

  if (matches.length === 1) {
    return matches[0]?.id ?? taskReference
  }

  if (matches.length > 1) {
    throw new Error(`team task reference '${trimmedTaskReference}' is ambiguous; use the numeric task ID`)
  }

  const availableTasks = tasks.slice(0, 5).map((task) => `${task.id}:${task.subject}`).join(", ")
  throw new Error(`team task '${trimmedTaskReference}' not found${availableTasks ? `; available tasks: ${availableTasks}` : ""}`)
}

const defaultDeps: TeamTaskToolDeps = {
  loadRuntimeState,
  createTask,
  listTasks,
  claimTask,
  updateTaskStatus,
  getTask,
}

async function resolveSenderName(teamRunId: string, config: TeamModeConfig, sessionID: string | undefined, deps: TeamTaskToolDeps): Promise<string> {
  const runtimeState: RuntimeState = await deps.loadRuntimeState(teamRunId, config)
  const matchedMember = runtimeState.members.find((member) => member.sessionId === sessionID)
  if (matchedMember) return matchedMember.name

  const leadMember = runtimeState.members.find((member) => member.agentType === "leader")
  if (leadMember) return leadMember.name

  throw new Error(`team member not found for session ${sessionID ?? "unknown"}`)
}

export function createTeamTaskCreateTool(config: TeamModeConfig, client: OpencodeClient, deps: TeamTaskToolDeps = defaultDeps): ToolDefinition {
  void client

  return tool({
    description: "Create a pending shared team task. Members claim/update it with team_task_update; track progress and results with team_task_list/team_task_get plus member team_send_message reports.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      subject: tool.schema.string().describe("Short task subject shown in team_task_list."),
      description: tool.schema.string().describe("Concrete assignment and expected result for the member."),
      blockedBy: tool.schema.array(tool.schema.string()).optional().describe("Task IDs that must complete before this task is available."),
    },
    execute: async (args: TeamTaskCreateArgs): Promise<string> => {
      const createdTask: Task = await deps.createTask(args.teamRunId, {
        subject: args.subject,
        description: args.description,
        blocks: [],
        blockedBy: args.blockedBy ?? [],
        status: "pending",
      }, config)

      return JSON.stringify({ taskId: createdTask.id, task: createdTask })
    },
  })
}

export function createTeamTaskListTool(config: TeamModeConfig, client: OpencodeClient, deps: TeamTaskToolDeps = defaultDeps): ToolDefinition {
  void client

  return tool({
    description: "List shared team tasks with owner/status metadata. Use this to track task completion; it does not include member message bodies.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      status: tool.schema.enum(["pending", "claimed", "in_progress", "completed", "deleted"]).optional().describe("Optional status filter."),
      owner: tool.schema.string().optional().describe("Optional member-name owner filter."),
    },
    execute: async (args: TeamTaskListArgs): Promise<string> => {
      const tasks = await deps.listTasks(args.teamRunId, config, { status: args.status, owner: args.owner })
      return JSON.stringify({ tasks })
    },
  })
}

export function createTeamTaskUpdateTool(config: TeamModeConfig, client: OpencodeClient, deps: TeamTaskToolDeps = defaultDeps): ToolDefinition {
  void client

  return tool({
    description: "Claim, start, complete, or delete a shared team task. Direct completion from pending/claimed auto-claims the task for the caller. Members should report substantive results separately with team_send_message.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      taskId: tool.schema.string().describe("Task ID, exact task subject, or subject slug"),
      status: tool.schema.enum(["pending", "claimed", "in_progress", "completed", "deleted"]).describe("New task status: claimed/in_progress while working, completed when done, deleted to remove."),
    },
    execute: async (args: TeamTaskUpdateArgs, ctx?: TeamTaskToolContext): Promise<string> => {
      const senderName = await resolveSenderName(args.teamRunId, config, ctx?.sessionID, deps)
      const taskId = await resolveTaskId(args.teamRunId, args.taskId, config, deps)

      const updatedTask = args.status === "claimed"
        ? await deps.claimTask(args.teamRunId, taskId, senderName, config)
        : await deps.updateTaskStatus(args.teamRunId, taskId, args.status, senderName, config)

      return JSON.stringify({ task: updatedTask })
    },
  })
}

export function createTeamTaskGetTool(config: TeamModeConfig, client: OpencodeClient, deps: TeamTaskToolDeps = defaultDeps): ToolDefinition {
  void client

  return tool({
    description: "Get one shared team task with its current owner/status metadata. It is for task state, not conversation history.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      taskId: tool.schema.string().describe("Task ID, exact task subject, or subject slug"),
    },
    execute: async (args: TeamTaskGetArgs): Promise<string> => {
      const taskId = await resolveTaskId(args.teamRunId, args.taskId, config, deps)
      const task = await deps.getTask(args.teamRunId, taskId, config)
      return JSON.stringify({ task })
    },
  })
}

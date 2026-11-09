import { bindAttemptSession, finalizeAttempt, startAttempt } from "../../features/background-agent/attempt-lifecycle"
import {
  archiveBackgroundTask,
  findRegisteredBackgroundTaskBySession,
  rememberBackgroundTask,
} from "../../features/background-agent/task-registry"
import { captureTaskTerminalEvidence } from "../../features/background-agent/task-terminal-evidence"
import type { BackgroundTask } from "../../features/background-agent/types"
import type { ParentContext } from "./executor-types"
import type { DelegateTaskArgs, DelegatedModelConfig, OpencodeClient } from "./types"

export function createSyncLifecycleTask(
  args: DelegateTaskArgs,
  parent: ParentContext,
  input: {
    readonly agent: string
    readonly sessionID: string
    readonly spawnDepth: number
    readonly startedAt: Date
  },
): BackgroundTask | undefined {
  if (!args.decisionId) return undefined
  const task: BackgroundTask = {
    id: `sync_${input.sessionID}`,
    decisionId: args.decisionId,
    parentSessionId: parent.sessionID,
    parentMessageId: parent.messageID,
    description: args.description,
    parentAgent: parent.agent,
    prompt: args.prompt,
    agent: input.agent,
    category: args.category,
    status: "pending",
    spawnDepth: input.spawnDepth,
    startedAt: input.startedAt,
  }
  return task
}

export function bindSyncLifecycleTask(
  task: BackgroundTask | undefined,
  session: string,
  model: DelegatedModelConfig | undefined,
): void {
  if (!task) return
  const current = task.currentAttemptID
  const startedAt = task.startedAt
  if (
    current &&
    task.sessionId &&
    (task.sessionId !== session ||
      task.model?.modelID !== model?.modelID ||
      task.model?.providerID !== model?.providerID)
  ) {
    const cause = task.sessionId === session ? "retry" : "fallback_replacement"
    finalizeAttempt(task, current, "error")
    startAttempt(task, model, cause)
  }
  const attempt = task.currentAttemptID ?? startAttempt(task, model).attemptId
  bindAttemptSession(task, attempt, session, model)
  task.startedAt = startedAt ?? task.startedAt
  const active = task.attempts?.find((item) => item.attemptId === attempt)
  if (active) active.startedAt = task.startedAt
  task.concurrencyGroup = model ? `${model.providerID}/${model.modelID}` : task.agent
  rememberBackgroundTask(task)
}

export function resumeSyncLifecycleTask(
  session: string,
  parent: string,
  retained?: BackgroundTask,
): BackgroundTask | undefined {
  const previous = retained ?? findRegisteredBackgroundTaskBySession(session, parent)
  if (!previous?.decisionId) return undefined
  const task = { ...previous, attempts: previous.attempts?.map((attempt) => ({ ...attempt })) }
  const model = task.model
  const attempt = startAttempt(task, model, "continuation")
  bindAttemptSession(task, attempt.attemptId, session, model)
  if (!retained) rememberBackgroundTask(task)
  return task
}

export async function finishSyncLifecycleTask(
  task: BackgroundTask | undefined,
  outcome: {
    readonly status: "completed" | "error" | "cancelled"
    readonly output?: string
    readonly archive?: boolean
  },
  client: OpencodeClient,
): Promise<void> {
  if (!task?.currentAttemptID) return
  task.result = outcome.output
  finalizeAttempt(
    task,
    task.currentAttemptID,
    outcome.status,
    undefined,
    captureTaskTerminalEvidence(task.sessionId, client),
  )
  if (outcome.archive !== false) archiveBackgroundTask(task)
}

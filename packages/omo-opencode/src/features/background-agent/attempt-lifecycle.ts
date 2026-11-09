import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { BackgroundTask, BackgroundTaskAttempt, BackgroundTaskStatus } from "./types"
import { publishTaskLifecycle, type TaskAttemptCause } from "./task-lifecycle"
import type { TaskTerminalEvidence } from "./task-terminal-evidence"
import { getRegisteredBackgroundTask } from "./task-registry"

function publishAttempt(task: BackgroundTask, attempt: BackgroundTaskAttempt): void {
  if (
    !task.decisionId ||
    attempt.lifecycleDetached ||
    (attempt.lifecycleStarted && attempt.lifecycleSessionId === attempt.sessionId)
  )
    return
  attempt.lifecycleStarted = true
  attempt.lifecycleSessionId = attempt.sessionId
  publishTaskLifecycle({
    event: "attempt",
    decisionId: task.decisionId,
    attemptId: attempt.attemptId,
    taskId: task.id,
    childSessionId: attempt.sessionId ?? null,
    cause: attempt.cause ?? "initial",
    resolvedModel: attempt.providerId && attempt.modelId ? `${attempt.providerId}/${attempt.modelId}` : null,
  })
}

type TerminalAttemptStatus = Extract<BackgroundTaskStatus, "completed" | "error" | "cancelled" | "interrupt">

function toAttemptModel(
  model: DelegatedModelConfig | undefined,
): Pick<BackgroundTaskAttempt, "providerId" | "modelId" | "variant"> {
  return {
    providerId: model?.providerID,
    modelId: model?.modelID,
    variant: model?.variant,
  }
}

function toTaskModel(attempt: BackgroundTaskAttempt): DelegatedModelConfig | undefined {
  if (!attempt.providerId || !attempt.modelId) {
    return undefined
  }

  return {
    providerID: attempt.providerId,
    modelID: attempt.modelId,
    ...(attempt.variant ? { variant: attempt.variant } : {}),
  }
}

function getAttemptIndex(task: BackgroundTask, attemptID: string): number {
  return task.attempts?.findIndex((attempt) => attempt.attemptId === attemptID) ?? -1
}

function getAttempt(task: BackgroundTask, attemptID: string): BackgroundTaskAttempt | undefined {
  const index = getAttemptIndex(task, attemptID)
  return index === -1 ? undefined : task.attempts?.[index]
}

function isTerminalStatus(status: BackgroundTaskStatus): status is TerminalAttemptStatus {
  return status === "completed" || status === "error" || status === "cancelled" || status === "interrupt"
}

export function getCurrentAttempt(task: BackgroundTask): BackgroundTaskAttempt | undefined {
  if (!task.currentAttemptID) {
    return undefined
  }

  return getAttempt(task, task.currentAttemptID)
}

export function ensureCurrentAttempt(
  task: BackgroundTask,
  model: DelegatedModelConfig | undefined = task.model,
): BackgroundTaskAttempt {
  const existingAttempt = getCurrentAttempt(task)
  if (existingAttempt) {
    return existingAttempt
  }

  const attempt: BackgroundTaskAttempt = {
    attemptId: `att_${crypto.randomUUID().slice(0, 8)}`,
    attemptNumber: (task.attempts?.length ?? 0) + 1,
    sessionId: task.sessionId,
    ...toAttemptModel(model),
    status: task.status,
    error: task.error,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  }

  task.attempts = [...(task.attempts ?? []), attempt]
  task.currentAttemptID = attempt.attemptId
  return attempt
}

export function projectTaskFromCurrentAttempt(task: BackgroundTask): BackgroundTask {
  const currentAttempt = getCurrentAttempt(task)
  if (!currentAttempt) {
    return task
  }

  task.status = currentAttempt.status
  task.sessionId = currentAttempt.sessionId
  task.startedAt = currentAttempt.startedAt
  task.completedAt = currentAttempt.completedAt
  task.error = currentAttempt.error
  const currentModel = toTaskModel(currentAttempt)
  task.model =
    currentModel && task.model?.providerID === currentModel.providerID && task.model.modelID === currentModel.modelID
      ? { ...task.model, ...currentModel, variant: currentAttempt.variant }
      : currentModel

  return task
}

export function startAttempt(
  task: BackgroundTask,
  model: DelegatedModelConfig | undefined,
  cause: TaskAttemptCause = "initial",
): BackgroundTaskAttempt {
  const attempt: BackgroundTaskAttempt = {
    cause,
    attemptId: `att_${crypto.randomUUID().slice(0, 8)}`,
    attemptNumber: (task.attempts?.length ?? 0) + 1,
    ...toAttemptModel(model),
    status: "pending",
  }

  task.attempts = [...(task.attempts ?? []), attempt]
  task.currentAttemptID = attempt.attemptId
  task.status = "pending"
  task.sessionId = undefined
  task.startedAt = undefined
  task.completedAt = undefined
  task.error = undefined
  task.model = model
  if (task.decisionId) {
    task.result = undefined
    task.producingModel = undefined
  }
  publishAttempt(task, attempt)

  return attempt
}

export function bindAttemptSession(
  task: BackgroundTask,
  attemptID: string,
  sessionID: string,
  model: DelegatedModelConfig | undefined,
): BackgroundTaskAttempt | undefined {
  ensureCurrentAttempt(task, model)
  if (task.currentAttemptID !== attemptID) {
    return undefined
  }

  const attempt = getAttempt(task, attemptID)
  if (!attempt || isTerminalStatus(attempt.status)) {
    return undefined
  }

  attempt.sessionId = sessionID
  attempt.status = "running"
  attempt.startedAt = new Date()
  attempt.completedAt = undefined
  attempt.error = undefined
  attempt.providerId = model?.providerID ?? attempt.providerId
  attempt.modelId = model?.modelID ?? attempt.modelId
  attempt.variant = model?.variant ?? attempt.variant
  publishAttempt(task, attempt)

  return getCurrentAttempt(projectTaskFromCurrentAttempt(task))
}

export function finalizeAttempt(
  task: BackgroundTask,
  attemptID: string,
  status: TerminalAttemptStatus,
  error?: string,
  evidence?: Promise<TaskTerminalEvidence>,
): BackgroundTaskAttempt | undefined {
  const attempt = getAttempt(task, attemptID)
  if (!attempt) {
    return undefined
  }

  const alreadyEmitted = attempt.lifecycleCompleted
  attempt.status = status
  attempt.completedAt = new Date()
  attempt.error = error

  if (task.currentAttemptID === attemptID) {
    projectTaskFromCurrentAttempt(task)
  }
  if (task.decisionId && !alreadyEmitted && !attempt.lifecycleDetached) {
    attempt.lifecycleCompleted = true
    const outcome = {
      event: "outcome" as const,
      decisionId: task.decisionId,
      attemptId: attempt.attemptId,
      taskId: task.id,
      childSessionId: attempt.sessionId ?? null,
      status: status === "error" ? ("failed" as const) : status === "interrupt" ? ("interrupted" as const) : status,
      producingModel: task.producingModel ?? null,
      output: status === "completed" ? task.result : undefined,
    }
    if (evidence) {
      void evidence.then(
        (observed) => {
          const registered = getRegisteredBackgroundTask(outcome.taskId)
          if (
            task.currentAttemptID !== outcome.attemptId ||
            (registered?.decisionId === outcome.decisionId &&
              registered.currentAttemptID !== undefined &&
              registered.currentAttemptID !== outcome.attemptId)
          ) {
            publishTaskLifecycle(outcome)
            return
          }
          publishTaskLifecycle({
            ...outcome,
            producingModel: observed.producingModel ?? outcome.producingModel,
            output: status === "completed" ? (outcome.output ?? observed.output) : undefined,
          })
        },
        () => publishTaskLifecycle(outcome),
      )
    } else publishTaskLifecycle(outcome)
  }

  return attempt
}

export function scheduleRetryAttempt(
  task: BackgroundTask,
  failedAttemptID: string,
  nextModel: DelegatedModelConfig,
  error?: string,
): BackgroundTaskAttempt | undefined {
  const failedAttempt = finalizeAttempt(task, failedAttemptID, "error", error)
  if (!failedAttempt || task.currentAttemptID !== failedAttemptID) {
    return undefined
  }

  return startAttempt(task, nextModel, "fallback_replacement")
}

export function findAttemptBySession(task: BackgroundTask, sessionID: string): BackgroundTaskAttempt | undefined {
  return task.attempts?.find((attempt) => attempt.sessionId === sessionID)
}

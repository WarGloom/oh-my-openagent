import type { BackgroundTask, BackgroundTaskSnapshot } from "./types"

function toSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
  const reasoningEffort = task.model?.reasoning ?? task.model?.reasoningEffort ?? task.model?.variant
  return Object.freeze({
    title: task.description || `${task.agent} background task`,
    ...(task.model === undefined ? {} : { model: task.model.modelID }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    status: task.status,
    toolCalls: task.progress?.toolCalls ?? null,
    lastTool: task.progress?.lastTool ?? null,
    agent: task.agent,
    parentSessionId: task.parentSessionId,
  })
}

export function toBackgroundTaskSnapshots(tasks: Iterable<BackgroundTask>): BackgroundTaskSnapshot[] {
  return Array.from(tasks, toSnapshot)
}

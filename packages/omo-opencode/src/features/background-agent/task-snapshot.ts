import type { BackgroundTask, BackgroundTaskSnapshot } from "./types"

function toSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
  return Object.freeze({
    title: task.description || `${task.agent} background task`,
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

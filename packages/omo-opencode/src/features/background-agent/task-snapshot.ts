import { getNativeFallbackModel } from "../../hooks/runtime-fallback/native-controller"
import type { BackgroundTask, BackgroundTaskSnapshot } from "./types"

function toSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
  // Native (V2) fallback switches the model inside the same session, so the launch model is stale after it.
  const native = task.sessionId === undefined ? undefined : getNativeFallbackModel(task.sessionId)
  const model = native?.model.modelID ?? task.model?.modelID
  const reasoningEffort = native
    ? (native.variant ?? native.reasoningEffort)
    : (task.model?.reasoning ?? task.model?.reasoningEffort ?? task.model?.variant)
  return Object.freeze({
    title: task.description || `${task.agent} background task`,
    ...(model === undefined ? {} : { model }),
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

import { cloneParentWake, type PendingParentWake } from "./parent-wake-dedupe"
import type { BackgroundTask } from "./types"

const MAX_COMPLETED_TASK_REGISTRY_SIZE = 100
const REGISTRY_KEY = "__omoBackgroundTaskRegistry"

type BackgroundTaskRegistry = {
  activeTasks: Map<string, (() => BackgroundTask) & { readonly retainedDirectory?: string }>
  completedTasks: Map<string, BackgroundTask>
  recoveryClaims?: Set<string>
  /** Parent wakes queued but not yet delivered when a manager unloaded, keyed by its directory. */
  retainedParentWakes?: Map<string, Map<string, PendingParentWake>>
}

type GlobalWithBackgroundTaskRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: BackgroundTaskRegistry
}

const TERMINAL_TASK_STATUSES = new Set<BackgroundTask["status"]>([
  "completed",
  "error",
  "cancelled",
  "interrupt",
])

function getRegistry(): BackgroundTaskRegistry {
  const registryGlobal = globalThis as GlobalWithBackgroundTaskRegistry
  registryGlobal[REGISTRY_KEY] ??= {
    activeTasks: new Map<string, () => BackgroundTask>(),
    completedTasks: new Map<string, BackgroundTask>(),
  }
  const registry = registryGlobal[REGISTRY_KEY]
  return registry
}

function cloneProgress(progress: BackgroundTask["progress"]): BackgroundTask["progress"] {
  if (!progress) {
    return undefined
  }

  return {
    ...progress,
    countedToolPartIDs: progress.countedToolPartIDs ? new Set(progress.countedToolPartIDs) : undefined,
  }
}

function cloneAttempts(attempts: BackgroundTask["attempts"]): BackgroundTask["attempts"] {
  if (!attempts) {
    return undefined
  }

  return attempts.map((attempt) => ({ ...attempt }))
}

function cloneRegisteredTask(task: BackgroundTask): BackgroundTask {
  return {
    id: task.id,
    rootSessionId: task.rootSessionId,
    parentSessionId: task.parentSessionId,
    parentMessageId: task.parentMessageId,
    teamRunId: task.teamRunId,
    description: task.description,
    prompt: "[redacted]",
    agent: task.agent,
    spawnDepth: task.spawnDepth,
    sessionId: task.sessionId,
    status: task.status,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    result: task.result,
    progress: cloneProgress(task.progress),
    parentModel: task.parentModel,
    model: task.model,
    fallbackChain: task.fallbackChain,
    attemptCount: task.attemptCount,
    concurrencyKey: task.concurrencyKey,
    concurrencyGroup: task.concurrencyGroup,
    parentAgent: task.parentAgent,
    parentTools: task.parentTools,
    isUnstableAgent: task.isUnstableAgent,
    error: task.error,
    category: task.category,
    retryNotification: task.retryNotification ? { ...task.retryNotification } : undefined,
    attempts: cloneAttempts(task.attempts),
    currentAttemptID: task.currentAttemptID,
    lastMsgCount: task.lastMsgCount,
    stablePolls: task.stablePolls,
    consecutiveMissedPolls: task.consecutiveMissedPolls,
  }
}

function trimCompletedTasks(registry: BackgroundTaskRegistry): void {
  while (registry.completedTasks.size > MAX_COMPLETED_TASK_REGISTRY_SIZE) {
    const oldestTaskID = registry.completedTasks.keys().next().value
    if (typeof oldestTaskID !== "string") {
      return
    }
    registry.completedTasks.delete(oldestTaskID)
  }
}

export function rememberBackgroundTask(task: BackgroundTask): void {
  const registry = getRegistry()
  registry.completedTasks.delete(task.id)
  registry.activeTasks.set(task.id, () => cloneRegisteredTask(task))
}

export function archiveBackgroundTask(task: BackgroundTask): void {
  const registry = getRegistry()
  registry.activeTasks.delete(task.id)
  registry.completedTasks.delete(task.id)
  if (!task.sessionId || !TERMINAL_TASK_STATUSES.has(task.status)) {
    return
  }
  registry.completedTasks.set(task.id, cloneRegisteredTask(task))
  trimCompletedTasks(registry)
}

export function getRegisteredBackgroundTask(taskID: string): BackgroundTask | undefined {
  const registry = getRegistry()
  const activeTask = registry.activeTasks.get(taskID)
  if (activeTask) {
    return cloneRegisteredTask(activeTask())
  }

  const completedTask = registry.completedTasks.get(taskID)
  return completedTask ? cloneRegisteredTask(completedTask) : undefined
}

export function forgetBackgroundTask(taskID: string): void {
  const registry = getRegistry()
  registry.activeTasks.delete(taskID)
  registry.completedTasks.delete(taskID)
}

export function retainBackgroundTaskForReload(task: BackgroundTask, directory: string): void {
  const retained = { ...task, progress: cloneProgress(task.progress), attempts: cloneAttempts(task.attempts), onSessionCreated: undefined }
  getRegistry().activeTasks.set(task.id, Object.assign(() => retained, { retainedDirectory: directory }))
}

export function takeBackgroundTasksAfterReload(directory: string): BackgroundTask[] {
  const registry = getRegistry()
  const tasks: BackgroundTask[] = []
  for (const [id, readTask] of registry.activeTasks) {
    if (readTask.retainedDirectory !== directory) continue
    tasks.push(readTask())
    registry.activeTasks.delete(id)
  }
  return tasks
}

export const MISSING_RETAINED_TASK_ERROR = "Retained-session recovery denied: no owned completed task with trusted agent/model metadata. The archive may have expired or the process restarted; do not substitute another agent."

function reserveRecoveryClaim(registry: BackgroundTaskRegistry, sessionID: string, parentSessionID: string): Set<string> {
  const claims = registry.recoveryClaims ??= new Set<string>()
  if (sessionID === parentSessionID || claims.has(sessionID) || [...registry.activeTasks.values()].some((getTask) => getTask().sessionId === sessionID)) {
    throw new Error("Retained-session recovery denied: session is active, claimed, or the caller itself.")
  }
  return claims
}

export function claimRetainedSessionRecovery(sessionID: string, parentSessionID: string): { task: BackgroundTask; release: () => void } {
  const registry = getRegistry()
  const claims = reserveRecoveryClaim(registry, sessionID, parentSessionID)
  const task = [...registry.completedTasks.values()].find((candidate) => candidate.sessionId === sessionID)
  if (!task || task.status !== "completed" || task.parentSessionId !== parentSessionID || !task.agent || !task.model) {
    throw new Error(MISSING_RETAINED_TASK_ERROR)
  }
  claims.add(sessionID)
  return { task: cloneRegisteredTask(task), release: () => { claims.delete(sessionID) } }
}

/** Reserves a retained session that has no archived record, e.g. after an OpenCode restart. The caller must prove ownership from the session itself. */
export function claimUnarchivedSessionRecovery(sessionID: string, parentSessionID: string): { release: () => void } {
  const registry = getRegistry()
  const claims = reserveRecoveryClaim(registry, sessionID, parentSessionID)
  if ([...registry.completedTasks.values()].some((candidate) => candidate.sessionId === sessionID)) {
    throw new Error(MISSING_RETAINED_TASK_ERROR)
  }
  claims.add(sessionID)
  return { release: () => { claims.delete(sessionID) } }
}

export function retainParentWakesForReload(directory: string, wakes: ReadonlyMap<string, PendingParentWake>): void {
  if (wakes.size === 0) return
  const registry = getRegistry()
  registry.retainedParentWakes ??= new Map()
  registry.retainedParentWakes.set(directory, new Map(Array.from(wakes, ([sessionID, wake]) => [sessionID, cloneParentWake(wake)])))
}

export function takeParentWakesAfterReload(directory: string): Map<string, PendingParentWake> {
  const registry = getRegistry()
  const wakes = registry.retainedParentWakes?.get(directory) ?? new Map<string, PendingParentWake>()
  registry.retainedParentWakes?.delete(directory)
  return wakes
}

export function clearBackgroundTaskRegistryForTesting(): void {
  const registry = getRegistry()
  registry.activeTasks.clear()
  registry.completedTasks.clear()
  registry.recoveryClaims?.clear()
  registry.retainedParentWakes?.clear()
}

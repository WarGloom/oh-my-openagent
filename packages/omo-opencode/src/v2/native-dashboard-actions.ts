import type { BackgroundTask } from "../features/background-agent/types"
import { log } from "../shared/logger"
import type { DashboardOwners } from "./dashboard-projection"

type TaskAction = { readonly sessionID: string; readonly taskID: string }
type MonitorAction = { readonly sessionID: string; readonly monitorID: string }

export class DashboardRetryUnavailableError extends Error {
  constructor(reason: "command" | "continued") {
    super(
      reason === "command"
        ? "Retry is unavailable for command-launched tasks"
        : "Retry is unavailable for continued tasks",
    )
  }
}

export function createDashboardActions(
  owners: DashboardOwners | undefined,
  authorize: (sessionID: string) => Promise<unknown>,
) {
  const cancelled = new Map<string, Promise<void>>()
  const stopped = new Map<string, Promise<void>>()
  const retries = new Map<string, Promise<{ taskID: string }>>()
  const taskFor = async ({ sessionID, taskID }: TaskAction): Promise<BackgroundTask> => {
    if (!(await authorize(sessionID))) throw new Error("Dashboard session is unavailable")
    const task = owners?.backgroundManager.getTasksByParentSession(sessionID).find((item) => item.id === taskID)
    if (!task) throw new Error("Task does not belong to this session")
    return task
  }
  return {
    cancelTask: async (input: TaskAction): Promise<void> => {
      log("[v2] dashboard cancel requested", input)
      const task = await taskFor(input)
      const prior = cancelled.get(task.id)
      if (prior) return prior
      if (task.status !== "pending" && task.status !== "running") throw new Error("Task status cannot be cancelled")
      const manager = owners?.backgroundManager
      if (!manager?.cancelTask) throw new Error("Dashboard task cancellation unavailable")
      const cancelTask = manager.cancelTask.bind(manager)
      const operation = (async () => {
        if (!(await cancelTask(task.id, { source: "dashboard" }))) throw new Error("Task could not be cancelled")
        log("[v2] dashboard task cancelled", input)
      })().finally(() => {
        cancelled.delete(task.id)
      })
      cancelled.set(task.id, operation)
      return operation
    },
    stopMonitor: async (input: MonitorAction): Promise<void> => {
      log("[v2] dashboard stop requested", input)
      if (!(await authorize(input.sessionID))) throw new Error("Dashboard session is unavailable")
      const manager = owners?.monitorManager
      const monitor = manager?.list(input.sessionID).find((item) => item.id === input.monitorID)
      if (!monitor) throw new Error("Monitor does not belong to this session")
      const prior = stopped.get(monitor.id)
      if (prior) return prior
      if (monitor.status !== "starting" && monitor.status !== "running")
        throw new Error("Monitor status cannot be stopped")
      if (!manager?.stop) throw new Error("Dashboard monitor stop unavailable")
      const stop = manager.stop.bind(manager)
      const operation = (async () => {
        await stop(monitor.id)
        log("[v2] dashboard monitor stopped", input)
      })().finally(() => {
        stopped.delete(monitor.id)
      })
      stopped.set(monitor.id, operation)
      return operation
    },
    retryTask: async (input: TaskAction): Promise<{ taskID: string }> => {
      log("[v2] dashboard retry requested", input)
      const task = await taskFor(input)
      if (task.teamRunId !== undefined) throw new Error("Cannot retry a team-member task from the dashboard")
      if (task.nativeContinued) throw new DashboardRetryUnavailableError("continued")
      switch (task.nativeInvocation?.kind) {
        case "command":
          throw new DashboardRetryUnavailableError("command")
        case "team":
          throw new Error("Cannot retry a team-member task from the dashboard")
        case "tool":
        case undefined:
          break
      }
      const prior = retries.get(task.id)
      if (prior) return prior
      if (task.status !== "error" && task.status !== "cancelled" && task.status !== "interrupt")
        throw new Error("Task status cannot be retried")
      const manager = owners?.backgroundManager
      if (!manager?.launch) throw new Error("Dashboard task retry unavailable")
      const retry = manager
        .launch({
          agent: task.agent,
          description: task.description,
          prompt: task.prompt,
          parentSessionId: task.parentSessionId,
          parentMessageId: task.parentMessageId,
          ...(task.category === undefined ? {} : { category: task.category }),
          ...(task.model === undefined ? {} : { model: { ...task.model } }),
          ...(task.skills === undefined ? {} : { skills: [...task.skills] }),
          ...(task.skillContent === undefined ? {} : { skillContent: task.skillContent }),
          ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
          ...(task.parentModel === undefined ? {} : { parentModel: { ...task.parentModel } }),
          ...(task.parentAgent === undefined ? {} : { parentAgent: task.parentAgent }),
          ...(task.parentTools === undefined ? {} : { parentTools: { ...task.parentTools } }),
          ...(task.sessionPermission === undefined
            ? {}
            : { sessionPermission: task.sessionPermission.map((rule) => ({ ...rule })) }),
          ...(task.userPermission === undefined ? {} : { userPermission: task.userPermission }),
          ...(task.fallbackChain === undefined ? {} : { fallbackChain: [...task.fallbackChain] }),
          ...(task.isUnstableAgent === undefined ? {} : { isUnstableAgent: task.isUnstableAgent }),
          ...(task.nativePrompt === undefined ? {} : { nativePrompt: task.nativePrompt }),
          ...(task.nativeInvocation === undefined ? {} : { nativeInvocation: task.nativeInvocation }),
          nativeTaskKey: `dashboard-retry:${task.id}`,
          nativeCompletion: "parent",
          nativeMode: "background",
        })
        .then((next) => {
          log("[v2] dashboard task retried", { ...input, newTaskID: next.id })
          return { taskID: next.id }
        })
        .catch((error: unknown) => {
          retries.delete(task.id)
          throw error
        })
      retries.set(task.id, retry)
      return retry
    },
  }
}

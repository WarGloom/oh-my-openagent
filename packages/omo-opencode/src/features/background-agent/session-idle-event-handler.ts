import { log } from "../../shared"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { MIN_IDLE_TIME_MS } from "./constants"
import type { BackgroundTask } from "./types"

export type SessionOutputClassification = "ready" | "no-output" | "incomplete-latest-assistant"

export function handleSessionIdleBackgroundEvent(args: {
  properties: Record<string, unknown>
  findBySession: (sessionID: string) => BackgroundTask | undefined
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  classifySessionOutput: (sessionID: string) => Promise<SessionOutputClassification>
  checkSessionTodos: (sessionID: string) => Promise<boolean>
  tryCompleteTask: (task: BackgroundTask, source: string) => Promise<boolean>
  tryFallbackForNoOutputIdle?: (task: BackgroundTask, source: string) => Promise<boolean>
  failNoOutputIdle?: (task: BackgroundTask, source: string) => Promise<void>
  emitIdleEvent: (sessionID: string) => void
}): void {
  const {
    properties,
    findBySession,
    idleDeferralTimers,
    classifySessionOutput,
    checkSessionTodos,
    tryCompleteTask,
    tryFallbackForNoOutputIdle,
    failNoOutputIdle,
    emitIdleEvent,
  } = args

  const sessionID = resolveSessionEventID(properties)
  if (!sessionID) return

  const task = findBySession(sessionID)
  if (!task || task.status !== "running") return

  const startedAt = task.startedAt
  if (!startedAt) return

  const elapsedMs = Date.now() - startedAt.getTime()
  if (elapsedMs < MIN_IDLE_TIME_MS) {
    const remainingMs = MIN_IDLE_TIME_MS - elapsedMs
    if (!idleDeferralTimers.has(task.id)) {
      log("[background-agent] Deferring early session.idle:", {
        elapsedMs,
        remainingMs,
        taskId: task.id,
      })
      const timer = setTimeout(() => {
        idleDeferralTimers.delete(task.id)
        emitIdleEvent(sessionID)
      }, remainingMs)
      idleDeferralTimers.set(task.id, timer)
    } else {
      log("[background-agent] session.idle already deferred:", { elapsedMs, taskId: task.id })
    }
    return
  }

  classifySessionOutput(sessionID)
    .then(async (sessionOutput) => {
      if (task.status !== "running") {
        log("[background-agent] Task status changed during validation, skipping:", {
          taskId: task.id,
          status: task.status,
        })
        return
      }

      switch (sessionOutput) {
        case "ready":
          break
        case "no-output": {
          const retried = await tryFallbackForNoOutputIdle?.(task, "session.idle no-output")
          if (retried) {
            log("[background-agent] Session.idle no-output fallback retry started:", task.id)
            return
          }
          if (failNoOutputIdle) {
            await failNoOutputIdle(task, "session.idle no-output")
            return
          }
          log("[background-agent] Session.idle but no output yet and no failure handler is registered, waiting:", task.id)
          return
        }
        case "incomplete-latest-assistant":
          log("[background-agent] Session.idle with incomplete latest assistant turn, waiting:", task.id)
          return
        default: {
          const exhaustive: never = sessionOutput
          return exhaustive
        }
      }

      const hasIncompleteTodos = await checkSessionTodos(sessionID)

      if (task.status !== "running") {
        log("[background-agent] Task status changed during todo check, skipping:", {
          taskId: task.id,
          status: task.status,
        })
        return
      }

      if (hasIncompleteTodos) {
        log("[background-agent] Task has incomplete todos, waiting for todo-continuation:", task.id)
        return
      }

      if (task.teamRunId) {
        log("[background-agent] Team member session went idle; skipping background auto-complete:", {
          taskId: task.id,
          teamRunId: task.teamRunId,
        })
        return
      }

      await tryCompleteTask(task, "session.idle event")
    })
    .catch((err) => {
      log("[background-agent] Error in session.idle handler:", err)
    })
}

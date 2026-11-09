import { log } from "../../shared/logger"

export type TaskAttemptCause = "initial" | "retry" | "fallback_replacement" | "continuation"
type Common = {
  readonly decisionId: string
  readonly attemptId: string
  readonly taskId: string
  readonly childSessionId: string | null
}
export type TaskLifecycleEvent = Common &
  (
    | { readonly event: "attempt"; readonly cause: TaskAttemptCause; readonly resolvedModel: string | null }
    | {
        readonly event: "outcome"
        readonly status: "completed" | "failed" | "cancelled" | "interrupted"
        readonly producingModel: string | null
        readonly output?: string
      }
  )
const observers = new Set<(event: TaskLifecycleEvent) => void>()

export function subscribeTaskLifecycle(observer: (event: TaskLifecycleEvent) => void): () => void {
  observers.add(observer)
  return () => {
    observers.delete(observer)
  }
}

export function publishTaskLifecycle(event: TaskLifecycleEvent): void {
  for (const observer of observers) {
    try {
      observer(event)
    } catch (error) {
      log("[background-agent] lifecycle observer failed", { error: error instanceof Error ? error.name : "unknown" })
    }
  }
}

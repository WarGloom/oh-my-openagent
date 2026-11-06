import type { log } from "../../shared"
import type { BackgroundTask } from "./types"

export class TaskVisibleChanges {
  private readonly observed = new WeakSet<BackgroundTask>()
  private readonly listeners = new Set<(sessionID: string) => void>()

  constructor(
    private readonly tasks: ReadonlyMap<string, BackgroundTask>,
    private readonly logger: typeof log,
  ) {}

  subscribe(listener: (sessionID: string) => void): () => void {
    const subscription = (sessionID: string) => listener(sessionID)
    this.listeners.add(subscription)
    return () => { this.listeners.delete(subscription) }
  }

  notify(sessionID: string): void {
    if (!sessionID || this.listeners.size === 0) return
    const listeners = [...this.listeners]
    queueMicrotask(() => {
      for (const listener of listeners) {
        if (!this.listeners.has(listener)) continue
        try {
          listener(sessionID)
        } catch (error) {
          this.logger("[background-agent] Visible change listener failed", { sessionID, error })
        }
      }
    })
  }

  observe(task: BackgroundTask): void {
    if (this.observed.has(task)) return
    this.observed.add(task)
    const observeProperty = <K extends "status" | "parentSessionId" | "sessionId">(key: K): void => {
      let value = task[key]
      Object.defineProperty(task, key, {
        enumerable: true,
        configurable: true,
        get: () => value,
        set: (next: BackgroundTask[K]) => {
          if (value === next) return
          const previousParent = task.parentSessionId
          value = next
          if (this.tasks.get(task.id) !== task) return
          if (previousParent !== task.parentSessionId) this.notify(previousParent)
          this.notify(task.parentSessionId)
        },
      })
    }
    observeProperty("status")
    observeProperty("parentSessionId")
    observeProperty("sessionId")
  }

  updateProgress(task: BackgroundTask, progress: BackgroundTask["progress"]): void {
    const changed = task.progress?.toolCalls !== progress?.toolCalls || task.progress?.lastTool !== progress?.lastTool
    task.progress = progress
    if (changed && this.tasks.get(task.id) === task) this.notify(task.parentSessionId)
  }
}

import { createHash } from "node:crypto"
import type { BackgroundManager } from "../features/background-agent/manager"
import type { NativeBackgroundLifecycle } from "../features/background-agent/native-lifecycle"
import type { BackgroundTask } from "../features/background-agent/types"
import { TERMINAL_TASK_TTL_MS } from "../features/background-agent/constants"
import { getRegisteredBackgroundTask, takeBackgroundTasksAfterReload } from "../features/background-agent/task-registry"
import type { V2IdleHookEvent, V2PluginContext, V2Registration, V2StorageDomain } from "./context-types"
import { backgroundTaskRecord, encodeBackgroundTask } from "./background-task-record"

function messageID(task: BackgroundTask, kind: string): string {
  return `msg_${createHash("sha256")
    .update(
      `${kind}:${task.id}:${task.currentAttemptID ?? ""}:${task.parentMessageId}:${task.startedAt?.toISOString() ?? task.sessionId}`,
    )
    .digest("hex")
    .slice(0, 26)}`
}

export class V2BackgroundLifecycle implements NativeBackgroundLifecycle {
  private manager?: BackgroundManager
  private registration?: V2Registration
  private readonly restored: Array<BackgroundTask & { readonly recoveryPrompt?: string }> = []
  private readonly recovered = new Set<string>()
  private readonly idleBeforeSetup = new Set<string>()
  private readonly migrated: BackgroundTask[] = []
  private readonly removed = new Set<string>()
  private readonly delivered = new Map<string, string>()
  private readonly idle = new Map<string, V2IdleHookEvent>()
  private stopped = false
  private readonly prefix: string

  constructor(
    private readonly context: V2PluginContext,
    private readonly storage: V2StorageDomain,
  ) {
    this.prefix = `background-task/${encodeURIComponent(context.location.directory)}/`
  }

  async load(): Promise<void> {
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        const task = backgroundTaskRecord.parse(entry.value)
        if (task.deliveredNoticeID) this.delivered.set(task.id, task.deliveredNoticeID)
        if (
          task.deliveredNoticeID &&
          task.completedAt &&
          Date.now() - task.completedAt.getTime() > TERMINAL_TASK_TTL_MS
        ) {
          await this.storage.remove(entry.key)
          continue
        }
        const child = await this.context.session
          .get({ sessionID: task.sessionId ?? task.parentSessionId })
          .catch((error: unknown) => {
            if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError")
              return undefined
            throw error
          })
        if (!child) {
          this.removed.add(task.id)
          await this.storage.remove(entry.key)
          continue
        }
        if (task.sessionId && child.parentID !== task.parentSessionId) continue
        if (task.sessionId && child.model)
          task.model = {
            ...task.model,
            providerID: child.model.providerID,
            modelID: child.model.id,
            variant: child.model.variant,
          }
        if (task.sessionId && child.time.idle !== undefined && child.time.idle >= (child.time.busy ?? 0))
          this.idleBeforeSetup.add(task.id)
        this.restored.push(task)
      }
      after = page.next
    } while (after)
    this.registration = await this.context.session.hook("experimental.idle", async (event) => {
      const task = this.manager?.findBySession(event.sessionID)
      if (task && task.status !== "running") return
      if (task?.status === "running") await this.save(task)
      if (task || !this.manager) this.idle.set(event.sessionID, event)
      if (!this.stopped && event.background.length === 0) {
        await this.manager?.completeNativeTask(event.sessionID)
        for (const [ancestorID, idle] of this.idle) {
          if (!idle.background.some((job) => job.sessionID === event.sessionID)) continue
          const task = this.manager?.findBySession(ancestorID)
          if (!task || task.status !== "running") continue
          this.idle.delete(ancestorID)
          await this.context.session.synthetic({
            sessionID: ancestorID,
            id: messageID(task, `settled:${event.sessionID}`),
            text: "The descendant's background work settled. Consume its results before reporting completion.",
            resume: true,
          })
        }
      }
    })
  }

  connect(manager: BackgroundManager): void {
    this.manager = manager
    const retained = takeBackgroundTasksAfterReload(this.context.location.directory)
    const retainedIDs = new Set(retained.map((task) => task.id))
    for (const task of retained) {
      if (this.removed.has(task.id)) continue
      if (this.restored.some((record) => record.id === task.id)) continue
      this.restored.push(task)
      this.migrated.push(task)
    }
    for (const task of this.restored) {
      if (task.status === "pending" && !task.sessionId) continue
      const previous = getRegisteredBackgroundTask(task.id)
      const runningInProcess =
        previous?.sessionId === task.sessionId &&
        previous?.parentSessionId === task.parentSessionId &&
        previous.status === "running"
      manager.adoptRetainedTask(task)
      if (!retainedIDs.has(task.id) && !runningInProcess) this.recovered.add(task.id)
    }
  }

  async start(): Promise<void> {
    for (const task of this.migrated) await this.save(task)
    for (const event of this.idle.values()) {
      if (event.background.length === 0) await this.manager?.completeNativeTask(event.sessionID)
    }
    for (const task of this.restored) {
      if (task.status === "pending" && !task.sessionId) {
        this.manager?.adoptRetainedTask(task)
        continue
      }
      if (task.status !== "running" && task.status !== "pending") {
        if (this.delivered.get(task.id) !== messageID(task, "complete")) await this.manager?.notifyNativeTask(task.id)
        continue
      }
      if ((!this.recovered.has(task.id) && !this.idleBeforeSetup.has(task.id)) || !task.sessionId) continue
      const messages = await this.context.session.context({ sessionID: task.sessionId })
      const idleID = messages.findLast((message) => message.type === "idle")?.id ?? "initial"
      // Re-admission wakes recovered notices too, even when this ID was already delivered.
      // Retained identities suppress recovery messages for children still running on this host.
      await this.context.session.synthetic({
        sessionID: task.sessionId,
        id: messageID(task, `recover:${idleID}`),
        text:
          task.recoveryPrompt ??
          "Continue the existing delegated task, including any pending background results. Report the final result when all work finishes.",
        delivery: "steer",
        resume: true,
      })
    }
  }

  async save(task: BackgroundTask): Promise<void> {
    if (task.sessionId) this.idle.delete(task.sessionId)
    await this.storage.set(
      `${this.prefix}${task.id}`,
      encodeBackgroundTask({
        ...task,
        deliveredNoticeID: this.delivered.get(task.id),
        ...(task.pendingResume ? { status: "running" as const } : {}),
        recoveryPrompt: task.pendingResume ? task.prompt : undefined,
      }),
    )
  }

  async notify(task: BackgroundTask, text: string): Promise<void> {
    await this.save(task)
    await this.context.session.synthetic({
      sessionID: task.parentSessionId,
      id: messageID(task, "complete"),
      text,
      description: task.description,
      delivery: "steer",
      resume: true,
    })
    this.delivered.set(task.id, messageID(task, "complete"))
    await this.save(task)
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.registration?.dispose()
  }
}

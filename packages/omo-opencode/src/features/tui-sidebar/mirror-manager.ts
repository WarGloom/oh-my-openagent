import { HEARTBEAT_MS, WRITE_DEBOUNCE_MS } from "./constants"
import { log } from "../../shared/logger"
import { writeMirror } from "./mirror-io"
import { writeSessionJobsMirror } from "./session-jobs-mirror"
import { buildTuiRuntimeSnapshot } from "./snapshot-builder"
import type {
  SessionAgentResolver,
  SessionStatusMap,
  TuiMirrorClient,
} from "./snapshot-builder"
import type { TuiRuntimeSnapshot } from "./snapshot-schema"
import type { JobRow } from "./state-types"
import type { BackgroundTaskSnapshot } from "../background-agent/types"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"

type TuiBackgroundSnapshotProvider = {
  readonly getTasksSnapshot: () => readonly BackgroundTaskSnapshot[]
}

type TuiMonitorCountsProvider = {
  readonly getActiveMonitorCounts: () => ReadonlyMap<string, number>
}

export type TuiStateMirrorInput = {
  readonly client: TuiMirrorClient
  readonly projectDir: string
  readonly backgroundManager: TuiBackgroundSnapshotProvider
  readonly monitorManager?: TuiMonitorCountsProvider
  readonly getStatuses?: () => Promise<SessionStatusMap>
  readonly sessionAgentResolver?: SessionAgentResolver
  readonly teamModeConfig?: TeamModeConfig
  readonly reportFlushError?: (error: Error) => void
}

export class TuiStateMirror {
  private readonly snapshotInput: TuiStateMirrorInput
  private readonly reportFlushError: (error: Error) => void
  private heartbeatID: ReturnType<typeof setInterval> | null = null
  private debounceID: ReturnType<typeof setTimeout> | null = null
  private pendingFlush: Promise<void> | null = null
  private resolvePendingFlush: (() => void) | null = null
  private inFlightFlush: Promise<void> | null = null
  private stopped = false
  private previousSessionIds = new Set<string>()

  constructor(input: TuiStateMirrorInput) {
    this.snapshotInput = input
    this.reportFlushError = input.reportFlushError ?? ((error) => log("[tui-sidebar] mirror flush failed", { error }))
  }

  buildSnapshot(): Promise<TuiRuntimeSnapshot> {
    return buildTuiRuntimeSnapshot(this.snapshotInput)
  }

  flush(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }

    if (this.pendingFlush) {
      return this.pendingFlush
    }

    const scheduledFlush = new Promise<void>((resolvePromise, rejectPromise) => {
      this.resolvePendingFlush = resolvePromise
      this.debounceID = setTimeout(() => {
        this.debounceID = null
        this.resolvePendingFlush = null
        this.runFlush().then(resolvePromise, rejectPromise)
      }, WRITE_DEBOUNCE_MS)
    })

    this.pendingFlush = scheduledFlush.then(
      () => {
        this.pendingFlush = null
      },
      (error: unknown) => {
        this.pendingFlush = null
        throw error
      },
    )
    return this.pendingFlush
  }

  onEvent(_event: unknown): void {
    void this.flush()
  }

  start(): void {
    this.stopped = false
    if (this.heartbeatID !== null) {
      return
    }
    this.heartbeatID = setInterval(() => {
      void this.flush()
    }, HEARTBEAT_MS)
    this.heartbeatID.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatID !== null) {
      clearInterval(this.heartbeatID)
      this.heartbeatID = null
    }
    if (this.debounceID !== null) {
      clearTimeout(this.debounceID)
      this.debounceID = null
    }
    if (this.resolvePendingFlush) {
      this.resolvePendingFlush()
      this.resolvePendingFlush = null
    }
    this.pendingFlush = null
  }

  private runFlush(): Promise<void> {
    if (this.inFlightFlush) {
      return this.inFlightFlush
    }

    const runningFlush = this.writeSnapshotNoThrow()
    this.inFlightFlush = runningFlush.then(
      () => {
        this.inFlightFlush = null
      },
      (error: unknown) => {
        this.inFlightFlush = null
        throw error
      },
    )
    return this.inFlightFlush
  }

  private async writeSnapshotNoThrow(): Promise<void> {
    try {
      const tasks = this.snapshotInput.backgroundManager.getTasksSnapshot()
      const snapshot = await this.buildSnapshot()
      if (this.stopped) {
        return
      }
      writeMirror(this.snapshotInput.projectDir, snapshot)
      const jobsByParentSession = new Map<string, JobRow[]>()
      for (const task of tasks) {
        const parentSessionId = task.parentSessionId
        const job = toJobRow(task)
        const sessionJobs = jobsByParentSession.get(parentSessionId)
        if (sessionJobs) {
          sessionJobs.push(job)
        } else {
          jobsByParentSession.set(parentSessionId, [job])
        }
      }
      const monitorCounts = this.snapshotInput.monitorManager?.getActiveMonitorCounts() ?? new Map<string, number>()
      const sessionIds = new Set([...jobsByParentSession.keys(), ...monitorCounts.keys(), ...this.previousSessionIds])
      for (const parentSessionId of sessionIds) {
        writeSessionJobsMirror(
          this.snapshotInput.projectDir,
          parentSessionId,
          jobsByParentSession.get(parentSessionId) ?? [],
          snapshot.updatedAt,
          monitorCounts.get(parentSessionId) ?? 0,
        )
      }
      this.previousSessionIds = new Set([...jobsByParentSession.keys(), ...monitorCounts.keys()])
    } catch (error) {
      if (error instanceof Error) {
        this.reportFlushError(error)
        return
      }
      throw error
    }
  }
}

function toJobRow(task: BackgroundTaskSnapshot): JobRow {
  return {
    title: task.title || `${task.agent} background task`,
    status: task.status,
    toolCalls: task.toolCalls,
    lastTool: task.lastTool,
  }
}

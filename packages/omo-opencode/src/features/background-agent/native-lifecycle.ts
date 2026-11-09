import type { BackgroundTask, LaunchInput, ResumeInput } from "./types"
import type { TaskPromptBody } from "./spawner/task-prompt-body"
import type { NativeSubagentReceipt } from "../../v2/native-subagent-types"

export interface NativeBackgroundJobs {
  readonly recover?: (
    sessionID: string,
    parentSessionID: string,
    archived?: BackgroundTask,
  ) => Promise<BackgroundTask | undefined>
  readonly prepare: (task: BackgroundTask, input: LaunchInput | ResumeInput, maxDepth: number) => Promise<void>
  readonly start: (task: BackgroundTask, body: TaskPromptBody) => Promise<"started" | "suspended">
  readonly cancel: (task: BackgroundTask) => Promise<void>
  readonly revokeProvisioning: (task: BackgroundTask) => Promise<void>
  readonly wait: (task: BackgroundTask) => Promise<NativeSubagentReceipt>
  readonly restore: (
    tasks: readonly BackgroundTask[],
    reconciled: (states: readonly NativeRestoredTask[]) => Promise<void>,
  ) => Promise<void>
  readonly stop: () => void
}

export type NativeRestoredTask = { readonly task: BackgroundTask; readonly receipt: NativeSubagentReceipt }

export interface NativeBackgroundLifecycle {
  readonly save: (task: BackgroundTask) => Promise<void>
  readonly notify: (task: BackgroundTask, text: string) => Promise<void>
}

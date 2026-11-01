import type { BackgroundTask } from "./types"

export interface NativeBackgroundLifecycle {
  readonly save: (task: BackgroundTask) => Promise<void>
  readonly notify: (task: BackgroundTask, text: string) => Promise<void>
}

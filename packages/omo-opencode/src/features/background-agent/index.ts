export * from "./types"
export {
  BackgroundManager,
  type SubagentSessionCreatedEvent,
  type OnSubagentSessionCreated,
  type SubagentSessionDeletedEvent,
  type OnSubagentSessionDeleted,
} from "./manager"
export { waitForTaskSessionID } from "./wait-for-task-session"
export type { WaitForTaskSessionIDOptions } from "./wait-for-task-session"
export { subscribeTaskLifecycle } from "./task-lifecycle"
export type { TaskLifecycleEvent } from "./task-lifecycle"

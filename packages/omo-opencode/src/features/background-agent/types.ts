import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { SessionPermissionRule } from "../../shared/question-denied-session-permission"
import type { NativeSubagentInvocation, NativeSubagentPrompt, NativeSubagentRun, NativeSubagentSkillSelection } from "../../v2/native-subagent-types"

export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "interrupt"

export interface ToolCallWindow {
  lastSignature: string
  consecutiveCount: number
  threshold: number
}

export interface TaskProgress {
  toolCalls: number
  lastTool?: string
  toolCallWindow?: ToolCallWindow
  countedToolPartIDs?: Set<string>
  lastUpdate: Date
  lastMessage?: string
  lastMessageAt?: Date
}

export type BackgroundTaskAttemptStatus = BackgroundTaskStatus

export type UserToolPermission = "ask" | "allow" | "deny"
export type BackgroundTaskUserPermission = Readonly<Record<string, UserToolPermission>>

export interface BackgroundTaskAttempt {
  attemptId: string
  attemptNumber: number
  sessionId?: string
  providerId?: string
  modelId?: string
  variant?: string
  status: BackgroundTaskAttemptStatus
  error?: string
  startedAt?: Date
  completedAt?: Date
}

export interface BackgroundTask {
  nativeAdmissionID?: string
  nativeProvisioningAdmissionID?: string
  nativeSkillActivationIDs?: readonly string[]
  nativeSkillSelections?: readonly NativeSubagentSkillSelection[]
  nativeAcceptedSkillsAdmissionID?: string
  nativePromptID?: string
  nativeRun?: NativeSubagentRun
  nativeInvocation?: NativeSubagentInvocation
  nativeCompletion?: "parent" | "none"
  nativeMode?: "foreground" | "background"
  nativeInheritedPermit?: boolean
  nativePrompt?: NativeSubagentPrompt
  nativeMetadata?: Readonly<Record<string, unknown>>
  nativeTaskKey?: string
  skills?: string[]
  id: string
  sessionId?: string
  rootSessionId?: string
  parentSessionId: string
  parentMessageId: string
  teamRunId?: string
  description: string
  prompt: string
  originalPrompt?: string
  agent: string
  spawnDepth?: number
  status: BackgroundTaskStatus
  queuedAt?: Date
  pendingResume?: object
  startedAt?: Date
  completedAt?: Date
  result?: string
  error?: string
  progress?: TaskProgress
  parentModel?: { providerID: string; modelID: string }
  model?: DelegatedModelConfig
  /** Fallback chain for runtime retry on model errors */
  fallbackChain?: FallbackEntry[]
  /** Number of fallback retry attempts made */
  attemptCount?: number
  /** Active concurrency slot key */
  concurrencyKey?: string
  /** Persistent key for re-acquiring concurrency on resume */
  concurrencyGroup?: string
  /** Parent session's agent name for notification */
  parentAgent?: string
  /** Parent session's tool restrictions for notification prompts */
  parentTools?: Record<string, boolean>
  skillContent?: string
  sessionPermission?: SessionPermissionRule[]
  /** Immutable copy of category/user tool permissions from launch time. */
  userPermission?: BackgroundTaskUserPermission
  /** Marks if the task was launched from an unstable agent/category */
  isUnstableAgent?: boolean
  /** Category used for this task (e.g., 'quick', 'visual-engineering') */
  category?: string
  /** Directory the child session is created and prompted in; defaults to the parent session directory */
  cwd?: string
  onSessionCreated?: (sessionId: string, model?: DelegatedModelConfig) => void | Promise<void>
  /** Last failed fallback retry token; prevents re-dispatching the same failed prompt. */
  failedFallbackRetryToken?: string
  fallbackDispatchGeneration?: number
  fallbackDispatchedAt?: number
  /** Pending retry notification details for the next spawned retry session */
  retryNotification?: {
    previousSessionID?: string
    failedModel?: string
    failedError?: string
    nextModel: string
  }

  /** Structured attempt history for retry observability */
  attempts?: BackgroundTaskAttempt[]
  /** ID of the currently active attempt */
  currentAttemptID?: string

  /** Last message count for stability detection */
  lastMsgCount?: number
  /** Number of consecutive polls with stable message count */
  stablePolls?: number
  /** Number of consecutive polls where session was missing from status map */
  consecutiveMissedPolls?: number
  /** Number of consecutive idle polls where the session still ended on an errored assistant turn */
  consecutiveErroredIdlePolls?: number
}

export interface BackgroundTaskSnapshot {
  readonly title: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly status: BackgroundTaskStatus
  readonly toolCalls: number | null
  readonly lastTool: string | null
  readonly agent: string
  readonly parentSessionId: string
}

export interface LaunchInput {
  nativeInheritedPermit?: boolean
  nativeSignal?: AbortSignal
  nativePrompt?: NativeSubagentPrompt
  nativeMetadata?: Readonly<Record<string, unknown>>
  nativeTaskKey?: string
  nativeInvocation?: NativeSubagentInvocation
  nativeCompletion?: "parent" | "none"
  nativeMode?: "foreground" | "background"
  description: string
  prompt: string
  agent: string
  parentSessionId: string
  parentMessageId: string
  teamRunId?: string
  suppressTmuxSpawn?: boolean
  parentModel?: { providerID: string; modelID: string }
  parentAgent?: string
  parentTools?: Record<string, boolean>
  model?: DelegatedModelConfig
  /** Fallback chain for runtime retry on model errors */
  fallbackChain?: FallbackEntry[]
  isUnstableAgent?: boolean
  skills?: string[]
  skillContent?: string
  category?: string
  sessionPermission?: SessionPermissionRule[]
  /** Directory the child session is created and prompted in; defaults to the parent session directory */
  cwd?: string
  onSessionCreated?: (sessionId: string, model?: DelegatedModelConfig) => void | Promise<void>
  /** User tool overrides (ask/allow/deny) from category or agent config. Merged into launchTools before hardcoded restrictions. */
  userPermission?: BackgroundTaskUserPermission
}

export interface ResumeInput {
  nativeInheritedPermit?: boolean
  nativeSignal?: AbortSignal
  nativePrompt?: NativeSubagentPrompt
  nativeMetadata?: Readonly<Record<string, unknown>>
  nativePromptID?: string
  nativeInvocation?: NativeSubagentInvocation
  nativeCompletion?: "parent" | "none"
  nativeMode?: "foreground" | "background"
  skills?: string[]
  sessionId: string
  prompt: string
  system?: string
  parentSessionId: string
  parentMessageId: string
  parentModel?: { providerID: string; modelID: string }
  parentAgent?: string
  parentTools?: Record<string, boolean>
}

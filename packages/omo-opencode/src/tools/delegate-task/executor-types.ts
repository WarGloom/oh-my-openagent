import type { BackgroundManager } from "../../features/background-agent"
import type {
  CategoriesConfig,
  GitMasterConfig,
  BrowserAutomationProvider,
  AgentOverrides,
  SisyphusAgentConfig,
  JevRoutingConfig,
} from "../../config/schema"
import type { ModelFallbackControllerAccessor } from "../../hooks/model-fallback"
import type { OpencodeClient } from "./types"
import type { NativeSubagentInvocation } from "../../v2/native-subagent-types"

export interface ExecutorContext {
  nativeInvocation?: NativeSubagentInvocation
  manager: BackgroundManager
  client: OpencodeClient
  directory: string
  userCategories?: CategoriesConfig
  requiredModel?: string
  jevRouting?: JevRoutingConfig
  abortSignal?: AbortSignal
  jevParentSessionID?: string
  jevOrchestratorCategory?: string
  jevSurface?: "task" | "team"
  gitMasterConfig?: GitMasterConfig
  sisyphusJuniorModel?: string
  browserProvider?: BrowserAutomationProvider
  agentOverrides?: AgentOverrides
  disabledAgents?: readonly string[]
  sisyphusAgentConfig?: SisyphusAgentConfig
  claudeCodeAgentsEnabled?: boolean
  modelFallbackControllerAccessor?: ModelFallbackControllerAccessor
  onSyncSessionCreated?: (event: { sessionID: string; parentID: string; title: string }) => Promise<void>
  syncPollTimeoutMs?: number
  taskCleanupDelayMs?: number
}

export interface ParentContext {
  sessionID: string
  messageID: string
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
}

export interface SessionMessage {
  info?: {
    id?: string
    role?: string
    time?: { created?: number }
    finish?: string
    error?: unknown
    agent?: string
    model?: { providerID: string; modelID: string; variant?: string }
    modelID?: string
    providerID?: string
    variant?: string
  }
  parts?: Array<{
    type?: string
    text?: string
    synthetic?: boolean
    tool?: string
    state?: {
      status?: string
      output?: string
      error?: string
    }
  }>
}

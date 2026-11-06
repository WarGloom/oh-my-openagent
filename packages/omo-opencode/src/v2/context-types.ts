import type { V2ToastRpc } from "./toast-channel"
import type { V2ExperimentalSkillDomain, V2SkillDomain, V2SubagentSkillsDomain } from "./native-skill-types"
import type { NativeSubagentDomain } from "./native-subagent-types"

/**
 * Structural view of the OpenCode 2.x plugin context (`@opencode/plugin` `Plugin.Context`).
 *
 * The adapter types only the members it reads. `@opencode/plugin` is deliberately not a dependency:
 * it pulls its own `effect` peer, and `dependency-security.test.ts` pins the single locked
 * `effect` version that the OpenCode 1.x plugin package needs. The real 2.x binary is the drift
 * check (see the opencode-qa V2 scripts), not a compile-time import.
 */

export type V2Registration = {
  readonly dispose: () => Promise<void>
}

export type V2Cleanup = () => Promise<void> | void

export type V2LocationProject = {
  readonly id: string
  readonly directory: string
  readonly canonical: string
}

export type V2Location = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: V2LocationProject
}

export type V2App = {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export type V2ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

export type V2ToolResult = {
  readonly output?: unknown
  readonly content?: string | ReadonlyArray<V2ToolContent>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type V2ToolExecuteContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  readonly progress: (update: Readonly<Record<string, unknown>>) => Promise<void>
}

export type V2ToolInfo = {
  readonly name: string
  readonly description: string
  /** Standard Schema, Effect Schema or JSON Schema; zod v4 schemas are Standard Schema. */
  readonly input: unknown
  readonly execute: (input: any, context: V2ToolExecuteContext) => Promise<V2ToolResult>
  readonly options?: { readonly codemode?: boolean; readonly permission?: string; readonly namespace?: string }
}

export type V2ToolEditor = {
  readonly add: (tool: V2ToolInfo) => void
  readonly list: () => ReadonlyArray<V2ToolInfo & { readonly id: string }>
  readonly update: (id: string, update: (tool: { -readonly [Key in keyof V2ToolInfo]: V2ToolInfo[Key] }) => void) => void
}

export type V2ToolContentPart = { type: string; text?: string; [key: string]: unknown }

export type V2ToolBeforeEvent = {
  tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

export type V2ToolAfterEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly input: unknown
  readonly status: "completed" | "error"
  /** Present when status is "completed"; the hook may rewrite it. */
  result?: { output?: unknown; content?: string | V2ToolContentPart[]; metadata?: Record<string, unknown> }
}

export type V2ToolDomain = {
  readonly transform: (callback: (editor: V2ToolEditor) => void) => Promise<V2Registration>
  readonly list: () => Promise<ReadonlyArray<V2ToolInfo & { readonly id: string }>>
  readonly hook: {
    (name: "execute.before", callback: (event: V2ToolBeforeEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "execute.after", callback: (event: V2ToolAfterEvent) => Promise<void> | void): Promise<V2Registration>
  }
}

export type V2Listed<T> = { readonly data: ReadonlyArray<T> }

export type V2ConfiguredModelInputs = {
  readonly providerID: string
  readonly modelID: string
  readonly input: ReadonlyArray<string>
}

export type V2ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }

export type V2ModelInfo = {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly name: string
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly enabled: boolean
  readonly package?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly capabilities: { readonly tools: boolean; readonly input: ReadonlyArray<string>; readonly output: ReadonlyArray<string>; readonly temperature?: boolean }
  readonly variants: ReadonlyArray<{ readonly id: string; readonly settings?: Readonly<Record<string, unknown>> }>
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
}

export type V2ProviderInfo = {
  readonly id: string
  readonly name: string
  readonly activation: "auto" | "enabled" | "disabled"
  readonly package?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly integrationID?: string
}

export type V2PermissionRule = {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** Input for the host `permission.assert` call; the encoded shape the 2.x plugin API accepts. */
export type V2PermissionAssertInput = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly save?: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type V2PermissionDomain = {
  /**
   * Evaluates the session's permission rules and, when approval is required, prompts and waits.
   * Resolves when allowed; a deny or a rejection rejects with an error that ends the current step.
   */
  readonly assert: (input: V2PermissionAssertInput) => Promise<void>
}

export type V2AgentInfo = {
  readonly id: string
  readonly name: string
  readonly model?: V2ModelRef
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden: boolean
  readonly color?: string
  readonly steps?: number
  readonly permissions: ReadonlyArray<V2PermissionRule>
}

export type V2ModelDomain = {
  readonly transform: (callback: (editor: V2ModelEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
  readonly list: () => Promise<V2Listed<V2ModelInfo>>
  readonly default: () => Promise<{ readonly data: V2ModelInfo | null }>
}

/** A mutable 2.x provider definition as the provider transform hands it out (the fields OMO writes). */
export type V2ModelEditor = {
  readonly get: (providerID: string, modelID: string) => V2ModelInfo | undefined
  readonly update: (providerID: string, modelID: string, update: (model: { variants: Array<V2ModelInfo["variants"][number]> }) => void) => void
  readonly provider: { readonly get: (providerID: string) => { readonly provider: V2ProviderInfo } | undefined }
}

export type V2ProviderDraft = {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package: string
  integrationID?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

/** A mutable 2.x model definition as the provider transform hands it out (the fields OMO writes). */
export type V2ModelDraft = {
  id: string
  name: string
  variants: Array<V2ModelInfo["variants"][number]>
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean }
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>
  limit: { context: number; input?: number; output: number }
}

export type V2ProviderEditor = {
  readonly get: (
    providerID: string,
  ) => { readonly provider: V2ProviderInfo; readonly models: ReadonlyMap<string, V2ModelInfo> } | undefined
  /** Creates the provider from the host's empty definition (activation `auto`) when the id is unknown. */
  readonly update: (providerID: string, update: (provider: V2ProviderDraft) => void) => void
  readonly models: {
    /** Creates the model from the host's default definition when the id is unknown. */
    readonly update: (providerID: string, modelID: string, update: (model: V2ModelDraft) => void) => void
  }
}

export type V2ProviderDomain = {
  readonly list: () => Promise<V2Listed<V2ProviderInfo>>
  readonly transform: (callback: (editor: V2ProviderEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
}

export type V2IntegrationMethod =
  | { readonly type: "key"; readonly label?: string }
  | { readonly type: "env"; readonly names: ReadonlyArray<string> }

export type V2IntegrationEditor = {
  readonly get: (id: string) => { readonly id: string; readonly name: string } | undefined
  readonly update: (id: string, update: (integration: { id: string; name: string }) => void) => void
  readonly method: {
    readonly update: (input: { readonly integrationID: string; readonly method: V2IntegrationMethod }) => void
  }
}

export type V2IntegrationDomain = {
  readonly transform: (callback: (editor: V2IntegrationEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
  readonly connection?: { readonly active: (integrationID: string) => Promise<{ readonly type: "credential"; readonly id: string } | { readonly type: "env"; readonly name: string } | undefined> }
}

/** A mutable 2.x agent as the agent transform hands it out. */
export type V2AgentRecord = {
  id: string
  name: string
  model?: V2ModelRef
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> }
  system?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: string
  steps?: number
  permissions: V2PermissionRule[]
}

export type V2AgentEditor = {
  readonly list: () => V2AgentRecord[]
  readonly get: (id: string) => V2AgentRecord | undefined
  readonly default: (id: string | undefined) => void
  /** Creates the agent from 2.x defaults when the id is unknown. */
  readonly update: (id: string, update: (agent: V2AgentRecord) => void) => void
  readonly remove: (id: string) => void
}

export type V2AgentDomain = {
  readonly list: () => Promise<V2Listed<V2AgentInfo>>
  readonly transform: (callback: (editor: V2AgentEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
}

export type V2McpTimeout = { readonly startup?: number; readonly catalog?: number; readonly execution?: number }

export type V2McpServerConfig =
  | {
      readonly type: "local"
      readonly command: ReadonlyArray<string>
      readonly cwd?: string
      readonly environment?: Readonly<Record<string, string>>
      readonly disabled?: boolean
      readonly codemode?: boolean
      readonly timeout?: V2McpTimeout
    }
  | {
      readonly type: "remote"
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
      readonly oauth?: false | Readonly<Record<string, string | number>>
      readonly disabled?: boolean
      readonly codemode?: boolean
      readonly timeout?: V2McpTimeout
    }

export type V2McpEditor = {
  readonly list: () => ReadonlyArray<readonly [string, V2McpServerConfig]>
  readonly get: (name: string) => V2McpServerConfig | undefined
  readonly set: (name: string, config: V2McpServerConfig) => void
  readonly remove: (name: string) => void
}

export type V2McpDomain = {
  readonly transform: (callback: (editor: V2McpEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
}

export type V2PromptMention = { readonly start: number; readonly end: number; readonly text: string }
export type V2PromptFile = {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly source?: { readonly type: "inline" } | { readonly type: "uri"; readonly uri: string }
  readonly mention?: V2PromptMention
} & Readonly<Record<string, unknown>>

export type V2PromptInput = {
  readonly sessionID: string
  readonly text: string
  /** Host attachment objects; fields beyond `uri`/`name` (source, mention, description) pass through unchanged. */
  readonly files?: ReadonlyArray<V2PromptFile>
  readonly agents?: ReadonlyArray<{ readonly name: string; readonly mention?: V2PromptMention }>
  readonly skills?: ReadonlyArray<{ readonly id: string; readonly arguments?: string; readonly mention?: V2PromptMention }>
  /** Carried to the `prompt` hook and stored on the user message. */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly delivery?: "steer" | "queue" | null
  /** false enqueues the message without starting a turn. */
  readonly resume?: boolean | null
}

export type V2SyntheticInput = {
  readonly sessionID: string
  readonly id?: string
  readonly text: string
  readonly description?: string | null
  readonly delivery?: "steer" | "queue" | null
  readonly resume?: boolean | null
}

export type V2TokenUsage = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type V2SessionInfo = {
  readonly id: string
  readonly permissions?: ReadonlyArray<V2PermissionRule>
  readonly parentID?: string
  readonly projectID: string
  readonly agent?: string
  readonly model?: V2ModelRef
  readonly title?: string
  readonly cost: number
  readonly tokens: V2TokenUsage
  readonly time: { readonly created: number; readonly updated: number; readonly busy?: number; readonly idle?: number }
  readonly location: { readonly directory: string }
}

export type V2StructuredError = { readonly type: string; readonly message: string; readonly status?: number; readonly response?: { readonly body: string } }

export type V2ToolContentItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

export type V2ToolState =
  | { readonly status: "streaming"; readonly input: string }
  | { readonly status: "running"; readonly input: Readonly<Record<string, unknown>>; readonly metadata: Readonly<Record<string, unknown>> }
  | {
      readonly status: "completed"
      readonly input: Readonly<Record<string, unknown>>
      readonly content: ReadonlyArray<V2ToolContentItem>
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly status: "error"
      readonly input: Readonly<Record<string, unknown>>
      readonly error: V2StructuredError
      readonly content?: ReadonlyArray<V2ToolContentItem>
      readonly metadata?: Readonly<Record<string, unknown>>
    }

export type V2AssistantContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string; readonly time?: { readonly created: number; readonly completed?: number } }
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly state: V2ToolState
      readonly time: { readonly created: number; readonly ran?: number; readonly completed?: number }
    }

type V2MessageBase = { readonly id: string; readonly time: { readonly created: number }; readonly metadata?: Readonly<Record<string, unknown>> }

/** The 2.x session message log entries the translator understands; others are ignored by type. */
export type V2SessionMessage =
  | (V2MessageBase & {
      readonly type: "user"
      readonly text: string
      readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>
    })
  | (V2MessageBase & { readonly type: "synthetic" | "system"; readonly text: string })
  | (V2MessageBase & { readonly type: "skill"; readonly name: string; readonly text: string })
  | (V2MessageBase & { readonly type: "agent-switched"; readonly agent: string })
  | (V2MessageBase & { readonly type: "model-switched"; readonly model: V2ModelRef })
  | (V2MessageBase & {
      readonly type: "assistant"
      readonly agent: string
      readonly model: V2ModelRef
      readonly content: ReadonlyArray<V2AssistantContent>
      readonly finish?: string
      readonly cost?: number
      readonly tokens?: V2TokenUsage
      readonly error?: V2StructuredError
      readonly time: { readonly created: number; readonly streamed?: number; readonly completed?: number }
    })
  | (V2MessageBase & { readonly type: "compaction"; readonly status: "running" | "completed" | "failed"; readonly reason: "auto" | "manual"; readonly summary?: string })
  | (V2MessageBase & {
      readonly type: "idle"
      /** How the execution that just ended finished; absent on entries from hosts that do not record it. */
      readonly outcome?: "succeeded" | "failed" | "interrupted"
      readonly error?: V2StructuredError
    })
  | (V2MessageBase & { readonly type: "shell" | "location-switched" })

export type V2SessionRequestKind = "primary" | "compaction" | "title" | "generate"

export type V2SystemPart = { type: string; text?: string } & Record<string, unknown>

export type V2RequestMessagePart = { type: string; text?: string } & Record<string, unknown>

export type V2RequestMessage = { role: string; content: string | V2RequestMessagePart[] } & Record<string, unknown>

export type V2PromptHookEvent = {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: { text: string } & Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type V2ContextHookEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly system: V2SystemPart[]
  readonly messages: V2RequestMessage[]
  readonly options: Record<string, unknown>
  readonly tools?: Record<string, { description: string; input: unknown }>
}

export type V2ModelRequestHookEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly kind: V2SessionRequestKind
  readonly connectionKey?: string
  baseURL?: string
  readonly headers: Record<string, string>
}

export type V2HttpRequestHookEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly kind: V2SessionRequestKind
  readonly connectionKey?: string
  request: Request
}

export type V2HttpResponseHookEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly kind: V2SessionRequestKind
  readonly connectionKey?: string
  readonly request: Request
  response: Response
}

export type V2CompactionResult = { summary: string } & Record<string, unknown>

export type V2CompactionHookEvent = V2ContextHookEvent & { result?: V2CompactionResult }

export type V2CompactionContinueEvent = {
  readonly sessionID: string
  readonly compactionID: string
  readonly reason: "auto" | "overflow"
  readonly agent: string
  readonly model: V2ModelRef
  enabled: boolean
}

export type V2RetryHookEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly error: V2StructuredError
  readonly attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

export type V2IdleHookEvent = {
  readonly sessionID: string
  readonly admit: (input: { readonly id: string; readonly text: string; readonly description?: string }) => Promise<"admitted" | "duplicate" | "stale">
  readonly background: ReadonlyArray<
    | { readonly kind: "shell"; readonly sessionID: string; readonly shellID: string; readonly command: string }
    | { readonly kind: "subagent"; readonly sessionID: string; readonly childSessionID: string; readonly agent: string; readonly description: string; readonly wakes?: boolean }
    | { readonly kind: "image"; readonly sessionID: string; readonly path: string; readonly model: string }
  >
}

type V2Json = null | boolean | number | string | ReadonlyArray<V2Json> | { readonly [key: string]: V2Json }

export type V2StorageDomain = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: V2Json) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => Promise<{
    readonly entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
    readonly next?: string
  }>
}

export type V2SessionDomain = {
  readonly instructions: { readonly entry: {
    readonly put: (input: { readonly sessionID: string; readonly key: string; readonly value: string }) => Promise<void>
    readonly remove: (input: { readonly sessionID: string; readonly key: string }) => Promise<void>
  } }
  readonly list: (input?: { readonly directory?: string; readonly parentID?: string | null; readonly limit?: number; readonly cursor?: string }) => Promise<{ readonly data: ReadonlyArray<V2SessionInfo>; readonly cursor: { readonly next?: string | null } }>
  readonly get: (input: { readonly sessionID: string }) => Promise<V2SessionInfo>
  readonly update: (input: { readonly sessionID: string; readonly title?: string; readonly permissions?: ReadonlyArray<V2PermissionRule> }) => Promise<void>
  readonly create: (input: {
    readonly parentID?: string | null
    readonly title?: string | null
    readonly agent?: string | null
    readonly model?: V2ModelRef | null
    readonly location?: { readonly directory: string } | null
    readonly permissions?: ReadonlyArray<V2PermissionRule> | null
  }) => Promise<V2SessionInfo>
  readonly remove: (input: { readonly sessionID: string }) => Promise<void>
  readonly context: (input: { readonly sessionID: string }) => Promise<ReadonlyArray<V2SessionMessage>>
  readonly wait: (input: { readonly sessionID: string }) => Promise<void>
  readonly interrupt: (input: { readonly sessionID: string; readonly resume?: boolean }) => Promise<unknown>
  readonly compact: (input: { readonly sessionID: string }) => Promise<unknown>
  readonly prompt: (input: V2PromptInput) => Promise<unknown>
  readonly synthetic: (input: V2SyntheticInput) => Promise<unknown>
  readonly switchAgent: (input: { readonly sessionID: string; readonly agent: string }) => Promise<void>
  readonly switchModel: (input: { readonly sessionID: string; readonly model: V2ModelRef }) => Promise<void>
  readonly hook: {
    (name: "prompt", callback: (event: V2PromptHookEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "context", callback: (event: V2ContextHookEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "model.request", callback: (event: V2ModelRequestHookEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "http.request", callback: (event: V2HttpRequestHookEvent) => Promise<void> | void, options?: { readonly providerID?: string }): Promise<V2Registration>
    (name: "http.response", callback: (event: V2HttpResponseHookEvent) => Promise<void> | void, options?: { readonly providerID?: string }): Promise<V2Registration>
    (name: "compaction", callback: (event: V2CompactionHookEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "experimental.compaction.continue", callback: (event: V2CompactionContinueEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "retry", callback: (event: V2RetryHookEvent) => Promise<void> | void): Promise<V2Registration>
    (name: "experimental.idle", callback: (event: V2IdleHookEvent) => Promise<void> | void): Promise<V2Registration>
  }
}

export type V2CommandInvocation = {
  readonly invocationID: string
  readonly agent: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly sessionID: string
  readonly prompt: Omit<V2PromptInput, "sessionID" | "delivery" | "resume" | "metadata">
  readonly delivery: "steer" | "queue"
}

export type V2CommandBeforeEvent = {
  readonly invocationID: string
  readonly agent: string
  readonly name: string
  readonly sessionID: string
  readonly delivery: "steer" | "queue"
  prompt: {
    text: string
    files?: V2PromptInput["files"]
    agents?: V2PromptInput["agents"]
    skills?: V2PromptInput["skills"]
  }
  metadata?: Record<string, unknown>
  disposition: "continue" | "handled" | "cancelled"
}

export type V2CommandDefinition = {
  readonly name: string
  readonly description?: string
  readonly execute: (invocation: V2CommandInvocation) => Promise<void>
}

export type V2CommandDomain = {
  readonly hook: (name: "experimental.command.before", callback: (event: V2CommandBeforeEvent) => Promise<void> | void) => Promise<V2Registration>
  readonly transform: (callback: (editor: { readonly add: (definition: V2CommandDefinition) => void }) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
}

/** A host event: `data` is the event's schema fields, which for session events include `sessionID`. */
export type V2Event = { readonly type: string; readonly data?: unknown }

export type V2EventDomain = {
  readonly subscribe: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<V2Event>
}

/** Experimental host recovery admission; mirrors `context.experimental.session.continueAfterFailure`. */
export type V2ContinueAfterFailureInput = {
  readonly sessionID: string
  /** Newest durable history entry the caller observed as the failed idle. */
  readonly boundaryID: string
  readonly id: string
  readonly text: string
  readonly description?: string
  readonly model?: V2ModelRef
}

export type V2ContinueAfterIdleInput = {
  readonly sessionID: string
  readonly boundaryID: string
  readonly id: string
  readonly text: string
  readonly description?: string
}

export type V2ExperimentalSessionDomain = {
  /** Trusted process snapshot; undefined preserves host process inheritance. */
  readonly environment: (input: { readonly sessionID: string }) => Promise<Readonly<Record<string, string>> | undefined>
  /** Accepts a failed boundary, or an interrupted boundary journaled by this plugin's own `interrupt`. */
  readonly continueAfterFailure: (input: V2ContinueAfterFailureInput) => Promise<"admitted" | "duplicate" | "stale">
  readonly continueAfterIdle: (input: V2ContinueAfterIdleInput) => Promise<"admitted" | "duplicate" | "stale">
  readonly recover: (input: { readonly sessionID: string }, callback: (input: { readonly boundaryID: string }) => Promise<boolean>, options?: { readonly signal?: AbortSignal }) => Promise<boolean>
  /** Plugin-owned interrupt; `boundaryID` is the interrupted idle this call produced, journaled for this plugin. */
  readonly interrupt: (input: { readonly sessionID: string }) => Promise<{ readonly interrupted: boolean; readonly boundaryID?: string }>
}

export type V2PluginContext = {
  readonly experimental: {
    readonly session: V2ExperimentalSessionDomain
    readonly model: { readonly configuredInputs: () => Promise<ReadonlyArray<V2ConfiguredModelInputs>> }
    readonly formatter: { readonly file: (input: { readonly sessionID: string; readonly filepath: string }) => Promise<boolean> }
    readonly variant: { readonly resolve: (input: { readonly model: V2ModelInfo }) => Promise<V2ModelInfo["variants"]> }
    readonly skill: V2ExperimentalSkillDomain
    readonly subagent: NativeSubagentDomain & V2SubagentSkillsDomain
  }
  readonly rpc: V2ToastRpc
  readonly app: V2App
  readonly location: V2Location
  readonly options: Readonly<Record<string, unknown>>
  readonly tool: V2ToolDomain
  readonly skill: V2SkillDomain
  readonly model: V2ModelDomain
  readonly provider: V2ProviderDomain
  readonly integration: V2IntegrationDomain
  readonly agent: V2AgentDomain
  readonly mcp: V2McpDomain
  readonly command: V2CommandDomain
  readonly session: V2SessionDomain
  readonly event: V2EventDomain
  readonly permission: V2PermissionDomain
  readonly storage?: V2StorageDomain
}

export type V2PluginDefinition = {
  readonly id: string
  readonly setup: (context: V2PluginContext) => Promise<V2Cleanup>
}

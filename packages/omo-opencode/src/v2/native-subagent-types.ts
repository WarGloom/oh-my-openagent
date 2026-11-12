import type { V2ModelRef, V2PermissionRule } from "./context-types"

export type NativeSubagentInvocation = { readonly agent: string } & (
  | {
      readonly kind: "tool"
      readonly messageID: string
      readonly toolCallID: string
      readonly team?: { readonly teamRunID: string; readonly member: string }
    }
  | { readonly kind: "command"; readonly invocationID: string; readonly command: string }
  | {
      readonly kind: "team"
      readonly invocationID: string
      readonly teamRunID: string
      readonly member: string
      readonly provisioningAdmissionID: string
    }
)

export type NativePromptMention = { readonly start: number; readonly end: number; readonly text: string }
export type NativeSubagentSkillSelection = {
  readonly id: string
  readonly arguments?: string
  readonly mention?: NativePromptMention
}
export type NativeSubagentPrompt = {
  readonly text: string
  readonly files?: readonly {
    readonly uri: string
    readonly name?: string
    readonly description?: string
    readonly source?: { readonly type: "inline" } | { readonly type: "uri"; readonly uri: string }
    readonly mention?: NativePromptMention
  }[]
  readonly agents?: readonly { readonly name: string; readonly mention?: NativePromptMention }[]
  readonly skills?: readonly NativeSubagentSkillSelection[]
}

export type NativeSubagentRun = { readonly childSessionID: string; readonly generation: string }
export type NativeSubagentTarget = { readonly admissionID: string } | { readonly run: NativeSubagentRun }
export type NativeSubagentReceipt = {
  readonly admissionID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly status: "authorizing" | "prepared" | "accepted" | "running" | "completed" | "error" | "cancelled"
  readonly run?: NativeSubagentRun
  readonly promptID?: string
  readonly completion?: "parent" | "none"
  readonly output?: string
  readonly outputModel?: V2ModelRef
  readonly error?: string
  readonly revoked?: true
}

export type NativeSubagentDomain = {
  readonly prepare: (
    input: {
      readonly admissionID: string
      readonly parentSessionID: string
      readonly agent: string
      readonly model: V2ModelRef
      readonly maxDepth: number
      readonly description: string
      readonly invocation: NativeSubagentInvocation
      readonly target:
        | {
            readonly kind: "create"
            readonly sessionID?: string
            readonly location?: { readonly directory: string }
            readonly permissions?: readonly V2PermissionRule[]
          }
        | { readonly kind: "existing"; readonly sessionID: string }
    },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<NativeSubagentReceipt>
  readonly start: (
    input: {
      readonly admissionID: string
      readonly promptID?: string
      readonly prompt: NativeSubagentPrompt
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly delivery: "queue" | "steer"
      readonly mode: "foreground" | "background"
      readonly completion: "parent" | "none"
    },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<NativeSubagentReceipt>
  readonly get: (input: NativeSubagentTarget) => Promise<NativeSubagentReceipt | undefined>
  readonly wait: (input: {
    readonly run: NativeSubagentRun
    readonly timeout?: number
  }) => Promise<{ readonly receipt: NativeSubagentReceipt; readonly timedOut: boolean }>
  readonly cancel: (input: NativeSubagentTarget) => Promise<NativeSubagentReceipt>
  readonly reconcile: (input?: { readonly parentSessionID?: string }) => Promise<readonly NativeSubagentReceipt[]>
  readonly ready: (input: { readonly run: NativeSubagentRun }) => Promise<NativeSubagentReceipt>
}

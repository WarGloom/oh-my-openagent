import type { V2CommandInvocation, V2ModelRef, V2PluginContext } from "../context-types"

export type CommandJobLaunch = {
  readonly agent: string
  readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
  readonly description: string
  readonly prompt: string
  readonly parentSessionId: string
  readonly parentMessageId: string
  readonly parentAgent: string
  readonly nativePrompt: V2CommandInvocation["prompt"]
  readonly nativeMetadata?: Readonly<Record<string, unknown>>
  readonly nativeInvocation: { readonly kind: "command"; readonly agent: string; readonly invocationID: string; readonly command: string }
  readonly nativeCompletion: "parent"
  readonly nativeMode: "background"
}

export type CommandJobQueue = { readonly launch: (input: CommandJobLaunch) => Promise<unknown> }
const queues = new WeakMap<V2PluginContext, CommandJobQueue>()

export function bindNativeCommandJobs(context: V2PluginContext, queue: CommandJobQueue): void {
  queues.set(context, queue)
}

export async function launchCommandSubtask(context: V2PluginContext, input: {
  readonly name: string
  readonly invocation: V2CommandInvocation
  readonly agent: string
  readonly model?: V2ModelRef
  readonly description: string
  readonly prompt: V2CommandInvocation["prompt"]
  readonly metadata?: Readonly<Record<string, unknown>>
}): Promise<void> {
  const queue = queues.get(context)
  if (!queue) throw new Error("Native command background manager has not been connected")
  await queue.launch({
    agent: input.agent,
    ...(input.model ? { model: { providerID: input.model.providerID, modelID: input.model.id, ...(input.model.variant ? { variant: input.model.variant } : {}) } } : {}),
    description: input.description, prompt: input.prompt.text,
    parentSessionId: input.invocation.sessionID, parentMessageId: input.invocation.invocationID, parentAgent: input.invocation.agent,
    nativePrompt: input.prompt, ...(input.metadata ? { nativeMetadata: input.metadata } : {}),
    nativeInvocation: { kind: "command", agent: input.invocation.agent, invocationID: input.invocation.invocationID, command: input.name },
    nativeCompletion: "parent", nativeMode: "background",
  })
}

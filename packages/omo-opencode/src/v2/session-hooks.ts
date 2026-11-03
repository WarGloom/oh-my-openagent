import type { Hooks } from "@opencode-ai/plugin"
import { registerPromptHook } from "./prompt-hook"
import { reconcileSystemTextParts } from "../plugin/system-text-parts"
import { createMessagesTransformHandler, getMessagesTransformHooks } from "../plugin/messages-transform"
import type { V2ModelRef, V2PluginContext, V2Registration } from "./context-types"
import { registerMessagesTransform, type V1MessageView } from "./messages-transform-bridge"
import { registerNativeTeamStatus } from "./native-team-status"
import { registerNativeMonitorStatus } from "./native-monitor-status"
import { registerNativeCategoryReminder } from "./native-category-reminder"
import { registerNativeTeamMailbox } from "./native-team-mailbox"

type V1ChatRequestInput = {
  readonly sessionID: string
  readonly agent: string
  readonly model: Record<string, unknown>
  readonly provider: Record<string, unknown>
  readonly message: Record<string, unknown>
}

type V1ChatMessageOutput = {
  message: Record<string, unknown>
  parts: Array<{ type: string; text?: string } & Record<string, unknown>>
}
type V1ChatParamsOutput = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options: Record<string, unknown>
}
type V1ChatHeadersOutput = { headers: Record<string, string> }
type V1SystemOutput = { system: string[] }
type V1CompactingOutput = { context: string[]; prompt?: string }

/**
 * The six 1.x request/compaction hooks as loose method signatures, so OpenCode's own
 * `(input: unknown, output: unknown)` handlers assign to it without reconstructing the full SDK
 * `Model`, `UserMessage` and `Part` types. Methods keep parameter checks bivariant, which is what
 * lets the strict `Hooks` object assign here.
 */
interface V1SessionHooks {
  "chat.message"?(input: { sessionID: string; messageID: string; agent?: string }, output: V1ChatMessageOutput): Promise<void> | void
  "chat.params"?(input: V1ChatRequestInput, output: V1ChatParamsOutput): Promise<void> | void
  "chat.headers"?(input: V1ChatRequestInput, output: V1ChatHeadersOutput): Promise<void> | void
  "experimental.chat.system.transform"?(
    input: { sessionID?: string; model: Record<string, unknown> },
    output: V1SystemOutput,
  ): Promise<void> | void
  "experimental.chat.messages.transform"?(input: Record<string, never>, output: { messages: V1MessageView[] }): Promise<void> | void
  "experimental.session.compacting"?(input: { sessionID: string }, output: V1CompactingOutput): Promise<void> | void
}

async function requestInput(context: V2PluginContext, event: { readonly sessionID: string; readonly agent: string; readonly model: V2ModelRef }): Promise<V1ChatRequestInput> {
  const { sessionID, agent, model } = event
  const [models, providers] = await Promise.all([context.model.list(), context.provider.list()])
  const info = models.data.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
  const provider = providers.data.find((entry) => entry.id === model.providerID)
  return {
    sessionID,
    agent,
    model: {
      ...info, providerID: model.providerID, modelID: model.id, id: model.id,
      ...(info ? {
        variants: Object.fromEntries(info.variants.map((variant) => [variant.id, variant.settings ?? {}])),
        capabilities: { ...info.capabilities, toolcall: info.capabilities.tools },
        api: { npm: info.package ?? provider?.package },
      } : {}),
    },
    provider: { ...provider, id: model.providerID, source: "api", info: provider ?? { id: model.providerID }, options: provider?.settings ?? {} },
    message: { id: "", sessionID, role: "user", time: { created: Date.now() }, agent, model: { providerID: model.providerID, modelID: model.id }, ...(model.variant === undefined ? {} : { variant: model.variant }) },
  }
}

async function registerChatParams(context: V2PluginContext, handler: NonNullable<V1SessionHooks["chat.params"]>): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    const options = event.options
    const { temperature, topP, topK, maxTokens, ...providerOptions } = options
    const output: V1ChatParamsOutput = {
      options: { ...providerOptions },
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(typeof topP === "number" ? { topP } : {}),
      ...(typeof topK === "number" ? { topK } : {}),
      ...(typeof maxTokens === "number" ? { maxOutputTokens: maxTokens } : {}),
    }
    await handler(await requestInput(context, event), output)
    for (const key of Object.keys(options)) delete options[key]
    if (typeof output.temperature === "number" && Number.isFinite(output.temperature)) options.temperature = output.temperature
    if (typeof output.topP === "number" && Number.isFinite(output.topP)) options.topP = output.topP
    if (typeof output.topK === "number" && Number.isFinite(output.topK)) options.topK = output.topK
    if (typeof output.maxOutputTokens === "number" && Number.isFinite(output.maxOutputTokens)) options.maxTokens = output.maxOutputTokens
    for (const [key, value] of Object.entries(output.options)) if (value !== undefined) options[key] = value
  })
}

async function registerChatHeaders(context: V2PluginContext, handler: NonNullable<V1SessionHooks["chat.headers"]>): Promise<V2Registration> {
  // Unscoped: the 1.x header hook (Copilot `x-initiator`) applied to every model request, so this
  // covers the primary, title, compaction and generate request kinds.
  return context.session.hook("model.request", async (event) => {
    const output: V1ChatHeadersOutput = { headers: {} }
    await handler(await requestInput(context, event), output)
    for (const [key, value] of Object.entries(output.headers)) if (typeof value === "string") event.headers[key] = value
  })
}

async function registerSystemTransform(context: V2PluginContext, handler: NonNullable<V1SessionHooks["experimental.chat.system.transform"]>): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    const textParts = event.system.filter((part) => typeof part.text === "string")
    await reconcileSystemTextParts({
      read: () => textParts.map((part) => part.text ?? ""),
      write: (texts) => {
        for (let index = 0; index < textParts.length; index++) {
          const text = texts[index]
          if (text !== undefined) textParts[index].text = text
        }
        const seen = new Set(textParts.map((part) => part.text))
        for (const text of texts.slice(textParts.length)) {
          if (text.length === 0 || seen.has(text)) continue
          seen.add(text)
          event.system.push({ type: "text", text })
        }
      },
    }, async (system) => handler({ sessionID: event.sessionID, model: { id: event.model.id, providerID: event.model.providerID } }, { system }))
  })
}

async function registerCompaction(context: V2PluginContext, handler: NonNullable<V1SessionHooks["experimental.session.compacting"]>): Promise<V2Registration> {
  return context.session.hook("compaction", async (event) => {
    const output: V1CompactingOutput = { context: [] }
    await handler({ sessionID: event.sessionID }, output)
    if (output.prompt !== undefined && output.prompt.length > 0) {
      const summary = [output.prompt, ...output.context].filter((part) => part.length > 0).join("\n\n")
      if (summary.length > 0) event.result = { summary }
      return
    }
    // 2.x has no separate sink for extra compaction context, so it rides on the compaction request's
    // system prompt, the closest faithful destination.
    for (const entry of output.context) if (entry.length > 0) event.system.push({ type: "text", text: entry })
  })
}

/**
 * Installs the 1.x request and compaction hooks a plugin's `server()` returns onto the 2.x session
 * domain, mapping each to the destination the migration guide names. Returns one disposer.
 */
export async function installSessionHooks(
  context: V2PluginContext,
  hooks: Hooks,
  deps: { readonly warn: (message: string) => void },
): Promise<() => Promise<void>> {
  const v1: V1SessionHooks = hooks
  const registrations: V2Registration[] = []

  const messages = v1["experimental.chat.messages.transform"]
  const transformHooks = messages === undefined ? undefined : getMessagesTransformHooks(messages)
  const teamStatus = transformHooks?.teamModeStatusInjector
  const monitorStatus = transformHooks?.monitorStatusInjector
  const categoryReminder = transformHooks?.categorySkillReminder
  const teamMailbox = transformHooks?.teamMailboxInjector
  if (teamStatus) registrations.push(await registerNativeTeamStatus(context, teamStatus))
  if (monitorStatus) registrations.push(await registerNativeMonitorStatus(context, monitorStatus))
  if (categoryReminder) registrations.push(await registerNativeCategoryReminder(context, categoryReminder))
  if (teamMailbox) registrations.push(await registerNativeTeamMailbox(context, teamMailbox))

  if (v1["chat.message"] !== undefined) registrations.push(await registerPromptHook(context, hooks, deps.warn))
  if (v1["chat.params"] !== undefined) registrations.push(await registerChatParams(context, v1["chat.params"]))
  if (v1["chat.headers"] !== undefined) registrations.push(await registerChatHeaders(context, v1["chat.headers"]))
  if (v1["experimental.chat.system.transform"] !== undefined) {
    registrations.push(await registerSystemTransform(context, v1["experimental.chat.system.transform"]))
  }
  if (messages !== undefined) {
    const transform = (teamStatus || monitorStatus || categoryReminder || teamMailbox) && transformHooks
      ? createMessagesTransformHandler({ hooks: { ...transformHooks, teamModeStatusInjector: null, monitorStatusInjector: null, categorySkillReminder: null, teamMailboxInjector: null } })
      : messages
    registrations.push(await registerMessagesTransform(context, (input, output) => Reflect.apply(transform, undefined, [input, output])))
  }
  if (v1["experimental.session.compacting"] !== undefined) {
    registrations.push(await registerCompaction(context, v1["experimental.session.compacting"]))
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

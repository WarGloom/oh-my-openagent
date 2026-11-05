import type { Hooks } from "@opencode-ai/plugin"
import { isRecord } from "@oh-my-opencode/utils"
import { z } from "zod"
import type { V2ModelRef, V2PluginContext, V2Registration, V2SessionInfo } from "./context-types"

interface PromptHooks {
  "chat.message"?(
    input: { sessionID: string; messageID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: {
      message: Record<string, unknown>
      parts: Array<{ type: string; text?: string } & Record<string, unknown>>
    },
  ): Promise<void> | void
}
type ModelOverride = { readonly previous: V2ModelRef; readonly selected: V2ModelRef }
const commandPartsSchema = z.array(
  z.object({ type: z.literal("text"), text: z.string(), synthetic: z.boolean().optional() }),
)

function sameModel(left: V2ModelRef | undefined, right: V2ModelRef): boolean {
  return left?.providerID === right.providerID && left.id === right.id && left.variant === right.variant
}

export async function registerPromptHook(
  context: V2PluginContext,
  hooks: Hooks,
  warn: (message: string) => void,
): Promise<V2Registration> {
  const v1: PromptHooks = hooks
  const handler = v1["chat.message"]
  if (!handler) return { dispose: async () => {} }
  const overrides = new Map<string, ModelOverride>()
  const originalEvent = hooks.event
  const onEvent: NonNullable<Hooks["event"]> = async (input) => {
    const properties: unknown = input.event.properties
    if (
      input.event.type === "session.deleted" &&
      isRecord(properties) &&
      isRecord(properties.info) &&
      typeof properties.info.id === "string"
    ) {
      overrides.delete(properties.info.id)
    }
    if (isRecord(properties) && typeof properties.sessionID === "string") {
      const sessionID = properties.sessionID
      if (input.event.type === "session.deleted") overrides.delete(sessionID)
      if (input.event.type === "session.idle") {
        const override = overrides.get(sessionID)
        overrides.delete(sessionID)
        if (override && sameModel((await context.session.get({ sessionID })).model, override.selected)) {
          await context.session.switchModel({ sessionID, model: override.previous })
        }
      }
    }
    await originalEvent?.(input)
  }
  hooks.event = onEvent
  const registration = await context.session.hook("prompt", async (event) => {
    let session: V2SessionInfo | undefined
    try {
      session = await context.session.get({ sessionID: event.sessionID })
    } catch (error) {
      warn(`prompt bridge session lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const current =
      session?.model ??
      (await context.agent.list()).data.find((agent) => agent.id === session?.agent)?.model ??
      (await context.model.default()).data
    const model = current && { providerID: current.providerID, modelID: current.id }
    const variant = current && "variant" in current ? current.variant : undefined
    const original = event.prompt.text
    const commandParts =
      event.metadata?.omoCommandParts === undefined
        ? undefined
        : commandPartsSchema.parse(event.metadata.omoCommandParts)
    const output: Parameters<NonNullable<PromptHooks["chat.message"]>>[1] = {
      message: {
        id: event.messageID,
        sessionID: event.sessionID,
        role: "user",
        time: { created: Date.now() },
        ...(session?.agent === undefined ? {} : { agent: session.agent }),
        ...(model ? { model } : {}),
        ...(variant === undefined ? {} : { variant }),
      },
      parts: (commandParts ?? [{ type: "text", text: original }]).map((part) => ({
        ...part,
        id: event.messageID,
        sessionID: event.sessionID,
        messageID: event.messageID,
      })),
    }
    await handler(
      { sessionID: event.sessionID, messageID: event.messageID, agent: session?.agent, ...(model ? { model } : {}) },
      output,
    )
    if (event.metadata) delete event.metadata.omoCommandParts
    const selectedModel = output.message.model
    if (
      isRecord(selectedModel) &&
      typeof selectedModel.providerID === "string" &&
      typeof selectedModel.modelID === "string"
    ) {
      const selected: V2ModelRef = {
        providerID: selectedModel.providerID,
        id: selectedModel.modelID,
        ...(typeof output.message.variant === "string" ? { variant: output.message.variant } : {}),
      }
      if (!sameModel(current ?? undefined, selected)) {
        await context.session.switchModel({ sessionID: event.sessionID, model: selected })
        if (current)
          overrides.set(event.sessionID, { previous: overrides.get(event.sessionID)?.previous ?? current, selected })
      }
    }
    if (typeof output.message.agent === "string" && output.message.agent !== session?.agent) {
      await context.session.switchAgent({ sessionID: event.sessionID, agent: output.message.agent })
    }
    event.prompt.text = output.parts
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
  })
  return {
    dispose: async () => {
      await registration.dispose()
      if (hooks.event === onEvent) hooks.event = originalEvent
      overrides.clear()
    },
  }
}

import type { V2ContextHookEvent, V2PluginContext, V2Registration, V2RequestMessage, V2RequestMessagePart } from "./context-types"

/** The 1.x `{ info, parts }` shape OMO's messages transform reads and mutates. */
export type V1MessageView = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

export type MessagesTransformHook = (
  input: Record<string, never>,
  output: { messages: V1MessageView[] },
) => Promise<void> | void

const INTERRUPTED_TOOL_ERROR = "[Tool execution was interrupted before it produced output]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contentParts(message: V2RequestMessage): V2RequestMessagePart[] {
  return Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : []
}

function textPartsFrom(parts: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return parts.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [{ type: "text", text: part.text }] : [],
  )
}

/**
 * Lowered 2.x `event.messages` as 1.x `{ info, parts }`. Each tool result is folded back into the
 * assistant tool part that called it, so a call still awaiting its result stays non-terminal, the
 * exact shape OMO's `toolPairValidator` repairs. The original 2.x message and the paired tool-result
 * ride along on private keys so a round trip re-emits them unchanged.
 */
function eventToV1(event: V2ContextHookEvent): V1MessageView[] {
  const views: V1MessageView[] = []
  const callParts = new Map<string, Record<string, unknown>>()
  for (const message of event.messages) {
    if (message.role === "tool") {
      for (const part of contentParts(message)) {
        const callID = typeof part.id === "string" ? part.id : undefined
        const target = callID === undefined ? undefined : callParts.get(callID)
        if (target === undefined) continue
        const state = target.state as Record<string, unknown>
        state.status = isRecord(part.result) && part.result.type === "error" ? "error" : "completed"
        target.__v2result = part
      }
      continue
    }
    if (message.role === "assistant") {
      const info: Record<string, unknown> = {
        role: "assistant",
        ...(typeof message.id === "string" ? { id: message.id } : {}),
        sessionID: event.sessionID,
        providerID: event.model.providerID,
        modelID: event.model.id,
      }
      const parts: Array<Record<string, unknown>> = []
      const extra: V2RequestMessagePart[] = []
      for (const part of contentParts(message)) {
        if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text })
        else if (part.type === "reasoning" && typeof part.text === "string") parts.push({ type: "reasoning", text: part.text })
        else if (part.type === "tool-call" && typeof part.id === "string") {
          const toolPart: Record<string, unknown> = {
            type: "tool",
            callID: part.id,
            tool: typeof part.name === "string" ? part.name : "",
            state: { status: "running", input: part.input },
            __v2call: part,
          }
          parts.push(toolPart)
          callParts.set(part.id, toolPart)
        } else extra.push(part)
      }
      views.push({ info: { ...info, __v2extra: extra }, parts })
      continue
    }
    const originalContent = contentParts(message)
    views.push({
      info: {
        role: message.role,
        ...(typeof message.id === "string" ? { id: message.id } : {}),
        sessionID: event.sessionID,
        __v2content: originalContent,
        __v2textCount: textPartsFrom(originalContent).length,
        ...(isRecord(message.metadata) ? { __v2metadata: message.metadata } : {}),
      },
      parts: textPartsFrom(originalContent),
    })
  }
  return views
}

function nonToolContent(view: V1MessageView): V2RequestMessagePart[] {
  const parts: V2RequestMessagePart[] = []
  for (const part of view.parts) {
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text })
    else if (part.type === "reasoning" && typeof part.text === "string") parts.push({ type: "reasoning", text: part.text })
    else if (part.type === "tool") {
      const call = (part as { __v2call?: V2RequestMessagePart }).__v2call
      parts.push(call ?? { type: "tool-call", id: String(part.callID ?? ""), name: String(part.tool ?? ""), input: (part.state as Record<string, unknown>)?.input })
    }
  }
  const extra = (view.info.__v2extra as V2RequestMessagePart[] | undefined) ?? []
  return [...parts, ...extra]
}

function toolResultMessages(view: V1MessageView): V2RequestMessage[] {
  const results: V2RequestMessage[] = []
  for (const part of view.parts) {
    if (part.type !== "tool") continue
    const state = part.state as Record<string, unknown>
    const terminal = state?.status === "completed" || state?.status === "error"
    if (!terminal) continue
    const original = (part as { __v2result?: V2RequestMessagePart }).__v2result
    if (original !== undefined) {
      results.push({ role: "tool", content: [original] })
      continue
    }
    const errorText = typeof state.error === "string" ? state.error : INTERRUPTED_TOOL_ERROR
    results.push({
      role: "tool",
      content: [{ type: "tool-result", id: String(part.callID ?? ""), name: String(part.tool ?? ""), result: { type: "error", value: errorText } }],
    })
  }
  return results
}

function withID(info: Record<string, unknown>): { id?: string } {
  return typeof info.id === "string" ? { id: info.id } : {}
}

/** Rebuilds lowered 2.x `event.messages` from the transformed 1.x views, re-pairing every repaired tool call. */
function v1ToEvent(views: ReadonlyArray<V1MessageView>): V2RequestMessage[] {
  const messages: V2RequestMessage[] = []
  for (const view of views) {
    const role = String(view.info.role ?? "user")
    if (role === "assistant") {
      messages.push({ ...withID(view.info), role: "assistant", content: nonToolContent(view) })
      messages.push(...toolResultMessages(view))
      continue
    }
    const original = view.info.__v2content as V2RequestMessagePart[] | undefined
    const appended = textPartsFrom(view.parts).slice(typeof view.info.__v2textCount === "number" ? view.info.__v2textCount : 0)
    const content = original === undefined ? textPartsFrom(view.parts) : [...original, ...appended]
    messages.push({
      ...withID(view.info),
      role,
      content: content as V2RequestMessagePart[],
      ...(isRecord(view.info.__v2metadata) ? { metadata: view.info.__v2metadata } : {}),
    })
  }
  return messages
}

/**
 * Bridges `experimental.chat.messages.transform` onto the 2.x `context` hook by translating the
 * request's own `event.messages` into the 1.x shape, running the hook, and rebuilding the request
 * from the result. Additive context, repaired tool states, and an appended assistant-tail recovery
 * turn all reach the model request. No re-entrant session read.
 */
export async function registerMessagesTransform(
  context: V2PluginContext,
  handler: MessagesTransformHook,
  warn: (message: string) => void,
): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    try {
      const output = { messages: eventToV1(event) }
      await handler({}, output)
      event.messages.splice(0, event.messages.length, ...v1ToEvent(output.messages))
    } catch (error) {
      warn(`messages.transform bridge skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

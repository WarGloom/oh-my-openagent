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

/** A 2.x content part as a 1.x part, keeping order. Text and reasoning map directly; anything else rides verbatim. */
function toV1Part(part: V2RequestMessagePart): Record<string, unknown> {
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
  if (part.type === "reasoning" && typeof part.text === "string") return { type: "reasoning", text: part.text }
  return { type: typeof part.type === "string" ? part.type : "unknown", __v2raw: part }
}

/**
 * Lowered 2.x `event.messages` as 1.x `{ info, parts }`, in the same order. Each tool result is
 * folded into the assistant tool part that called it, so a call still awaiting its result stays
 * non-terminal, the shape OMO's `toolPairValidator` repairs. Originals ride on private keys so a
 * round trip re-emits them unchanged.
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
    const info: Record<string, unknown> = {
      role: message.role,
      ...(typeof message.id === "string" ? { id: message.id } : {}),
      sessionID: event.sessionID,
      ...(message.role === "assistant" ? { providerID: event.model.providerID, modelID: event.model.id } : {}),
      ...(isRecord(message.metadata) ? { __v2metadata: message.metadata } : {}),
    }
    const parts: Array<Record<string, unknown>> = []
    for (const part of contentParts(message)) {
      if (message.role === "assistant" && part.type === "tool-call" && typeof part.id === "string") {
        const toolPart: Record<string, unknown> = {
          type: "tool",
          callID: part.id,
          tool: typeof part.name === "string" ? part.name : "",
          state: { status: "running", input: part.input },
          __v2call: part,
        }
        parts.push(toolPart)
        callParts.set(part.id, toolPart)
        continue
      }
      parts.push(toV1Part(part))
    }
    views.push({ info, parts })
  }
  return views
}

/** Content parts for one message, in order. Tool results are emitted separately, not inline. */
function rebuildContent(view: V1MessageView): V2RequestMessagePart[] {
  return view.parts.flatMap((part): V2RequestMessagePart[] => {
    const raw = (part as { __v2raw?: V2RequestMessagePart }).__v2raw
    if (raw !== undefined) return [raw]
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
    if (part.type === "reasoning" && typeof part.text === "string") return [{ type: "reasoning", text: part.text }]
    if (part.type === "tool") {
      const call = (part as { __v2call?: V2RequestMessagePart }).__v2call
      return [call ?? { type: "tool-call", id: String(part.callID ?? ""), name: String(part.tool ?? ""), input: (part.state as Record<string, unknown>)?.input }]
    }
    return []
  })
}

function toolResultMessages(view: V1MessageView): V2RequestMessage[] {
  const results: V2RequestMessage[] = []
  for (const part of view.parts) {
    if (part.type !== "tool") continue
    const state = part.state as Record<string, unknown>
    if (state?.status !== "completed" && state?.status !== "error") continue
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

/**
 * Rebuilds lowered 2.x `event.messages` from the transformed 1.x views, in list order. Messages the
 * hook inserted, removed or reordered carry through because the request is rebuilt from the view
 * list, not aligned by index. Repaired tool calls re-pair with a synthesized error tool-result.
 */
function v1ToEvent(views: ReadonlyArray<V1MessageView>): V2RequestMessage[] {
  const messages: V2RequestMessage[] = []
  for (const view of views) {
    const role = String(view.info.role ?? "user")
    const message: V2RequestMessage = {
      ...(typeof view.info.id === "string" ? { id: view.info.id } : {}),
      role,
      content: rebuildContent(view),
      ...(isRecord(view.info.__v2metadata) ? { metadata: view.info.__v2metadata } : {}),
    }
    messages.push(message)
    if (role === "assistant") messages.push(...toolResultMessages(view))
  }
  return messages
}

/**
 * Bridges `experimental.chat.messages.transform` onto the 2.x `context` hook by translating the
 * request's own `event.messages` into the 1.x shape, running the hook, and rebuilding the request
 * from the result. Additive context (in the hook's order), repaired tool states, inserted or
 * reordered messages, and an appended assistant-tail recovery turn all reach the model request. No
 * re-entrant session read.
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

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

/**
 * A 2.x content part as a 1.x part. The original 2.x part rides on `__v2raw`, so it is re-emitted
 * unchanged (keeping `encrypted` signatures, providerMetadata, cache fields and any field added to
 * the schema later) unless a hook edits the text. Text and reasoning also expose `text` for the hooks.
 */
function toV1Part(part: V2RequestMessagePart): Record<string, unknown> {
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text, __v2raw: part }
  if (part.type === "reasoning" && typeof part.text === "string") return { type: "reasoning", text: part.text, __v2raw: part }
  return { type: typeof part.type === "string" ? part.type : "unknown", __v2raw: part }
}

/**
 * Lowered 2.x `event.messages` as 1.x `{ info, parts }`, in the same order. Each tool result folds
 * into the assistant tool part that called it, so a call still awaiting its result stays
 * non-terminal, the shape OMO's `toolPairValidator` repairs. Original parts, tool-result messages and
 * whole messages ride on private keys so an unchanged round trip re-emits them unchanged.
 */
function eventToV1(event: V2ContextHookEvent): { messages: V1MessageView[]; prefix: V2RequestMessage[] } {
  const views: V1MessageView[] = []
  const prefix: V2RequestMessage[] = []
  const callParts = new Map<string, Record<string, unknown>>()
  for (const message of event.messages) {
    if (message.role === "system" || message.role === "tool") {
      // V1 transforms run before lowering: system updates are not conversation turns.
      const previous = views.at(-1)
      const following = previous?.info.__v2following as V2RequestMessage[] | undefined
      if (following !== undefined) following.push(message)
      else prefix.push(message)
    }
    if (message.role === "system") continue
    if (message.role === "tool") {
      for (const part of contentParts(message)) {
        const callID = typeof part.id === "string" ? part.id : undefined
        const target = callID === undefined ? undefined : callParts.get(callID)
        if (target === undefined) continue
        const state = target.state as Record<string, unknown>
        state.status = isRecord(part.result) && part.result.type === "error" ? "error" : "completed"
        target.__v2resultMessage = message
      }
      continue
    }
    const info: Record<string, unknown> = {
      role: message.role,
      ...(typeof message.id === "string" ? { id: message.id } : {}),
      sessionID: event.sessionID,
      ...(message.role === "assistant" ? { providerID: event.model.providerID, modelID: event.model.id } : {}),
      __v2message: message,
      __v2following: [],
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
  return { messages: views, prefix }
}

/** One content part, re-emitted verbatim unless the hook added or changed it. */
function rebuildPart(part: Record<string, unknown>): V2RequestMessagePart[] {
  const raw = (part as { __v2raw?: V2RequestMessagePart }).__v2raw
  if (part.type === "tool") {
    const call = (part as { __v2call?: V2RequestMessagePart }).__v2call
    return [call ?? { type: "tool-call", id: String(part.callID ?? ""), name: String(part.tool ?? ""), input: (part.state as Record<string, unknown>)?.input }]
  }
  if (raw !== undefined) {
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.text !== raw.text) {
      return [{ ...raw, text: part.text }]
    }
    return [raw]
  }
  if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
  if (part.type === "reasoning" && typeof part.text === "string") return [{ type: "reasoning", text: part.text }]
  return []
}

function toolResultMessages(view: V1MessageView): V2RequestMessage[] {
  const results: V2RequestMessage[] = []
  for (const part of view.parts) {
    if (part.type !== "tool") continue
    const state = part.state as Record<string, unknown>
    if (state?.status !== "completed" && state?.status !== "error") continue
    const originalMessage = (part as { __v2resultMessage?: V2RequestMessage }).__v2resultMessage
    if (originalMessage !== undefined) continue
    const errorText = typeof state.error === "string" ? state.error : INTERRUPTED_TOOL_ERROR
    results.push({
      role: "tool",
      content: [{ type: "tool-result", id: String(part.callID ?? ""), name: String(part.tool ?? ""), result: { type: "error", value: errorText } }],
    })
  }
  return results
}

/**
 * Rebuilds lowered 2.x `event.messages` from the transformed 1.x views, in list order. An unchanged
 * message passes through as its original object with rebuilt content, so the round trip is lossless.
 * Inserted, removed or reordered messages carry through because the request is rebuilt from the view
 * list, not aligned by index. Repaired tool calls re-pair with a synthesized error tool-result.
 */
function v1ToEvent(views: ReadonlyArray<V1MessageView>): V2RequestMessage[] {
  const messages: V2RequestMessage[] = []
  for (const view of views) {
    const role = String(view.info.role ?? "user")
    const content = view.parts.flatMap(rebuildPart)
    const original = view.info.__v2message as V2RequestMessage | undefined
    const originalContent = original?.content
    const unchanged = original !== undefined && role === original.role && (
      typeof originalContent === "string"
        ? content.length === 1 && content[0]?.type === "text" && content[0].text === originalContent
        : originalContent !== undefined && content.length === originalContent.length && content.every((part, index) => part === originalContent[index])
    )
    messages.push(unchanged ? original : { ...original, ...(typeof view.info.id === "string" ? { id: view.info.id } : {}), role, content })
    if (role === "assistant") messages.push(...toolResultMessages(view))
    const following = view.info.__v2following as V2RequestMessage[] | undefined
    if (following !== undefined) messages.push(...following)
  }
  return messages
}

/**
 * Bridges `experimental.chat.messages.transform` onto the 2.x `context` hook by translating the
 * request's own `event.messages` into the 1.x shape, running the hook, and rebuilding the request
 * from the result. A no-op round trip is lossless; additive context (in the hook's order), repaired
 * tool states, inserted or reordered messages, and an appended assistant-tail recovery turn all reach
 * the model request. No re-entrant session read.
 */
export async function registerMessagesTransform(
  context: V2PluginContext,
  handler: MessagesTransformHook,
): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    const output = eventToV1(event)
    await handler({}, output)
    event.messages.splice(0, event.messages.length, ...output.prefix, ...v1ToEvent(output.messages))
  })
}

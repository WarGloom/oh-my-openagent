import type {
  V2ContextHookEvent,
  V2PluginContext,
  V2Registration,
  V2RequestMessage,
} from "./context-types"
import { translateMessages } from "./client-facade/translate-messages"

/** The 1.x `{ info, parts }` shape the messages transform reads and mutates. */
export type V1MessageView = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

export type MessagesTransformHook = (
  input: Record<string, never>,
  output: { messages: V1MessageView[] },
) => Promise<void> | void

function joinText(parts: ReadonlyArray<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
}

/**
 * Extra text the hook left on a message. The 1.x transforms are additive (injected context, team
 * status, reminders), so the result normally keeps the original as a prefix; a full rewrite falls
 * back to the whole new text.
 */
function extractDelta(before: string, after: string): string {
  if (after === before) return ""
  if (before.length > 0 && after.startsWith(before)) return after.slice(before.length).replace(/^\n+/, "")
  return after
}

function appendToMessage(message: V2RequestMessage, text: string): void {
  if (Array.isArray(message.content)) message.content.push({ type: "text", text })
  else if (typeof message.content === "string") message.content = `${message.content}\n${text}`
}

/**
 * Builds the 1.x message list from the 2.x session log through `translateMessages`, the same reader
 * the client facade uses, so the hook sees the whole conversation as it did on 1.x.
 */
async function buildV1Messages(context: V2PluginContext, sessionID: string): Promise<V1MessageView[]> {
  const [info, log] = await Promise.all([
    context.session.get({ sessionID }),
    context.session.context({ sessionID }),
  ])
  const translated = translateMessages({
    messages: log,
    sessionID,
    directory: info.location.directory,
    worktree: context.location.project.canonical,
    initial: { agent: info.agent ?? "", ...(info.model === undefined ? {} : { model: info.model }) },
  })
  return translated.map((message) => ({ info: { ...message.info }, parts: message.parts.map((part) => ({ ...part })) }))
}

function applyDelta(event: V2ContextHookEvent, before: readonly string[], after: readonly V1MessageView[]): void {
  let lastUserIndex = -1
  for (let index = 0; index < event.messages.length; index += 1) {
    if (event.messages[index]?.role === "user") lastUserIndex = index
  }
  const shared = Math.min(before.length, after.length)
  for (let index = 0; index < shared; index += 1) {
    const delta = extractDelta(before[index] ?? "", joinText(after[index]?.parts ?? []))
    if (delta.length === 0) continue
    const role = String(after[index]?.info.role ?? "")
    const lastUser = lastUserIndex >= 0 ? event.messages[lastUserIndex] : undefined
    if (role === "user" && lastUser !== undefined) appendToMessage(lastUser, delta)
    else event.system.push({ type: "text", text: delta })
  }
  for (let index = shared; index < after.length; index += 1) {
    const text = joinText(after[index]?.parts ?? [])
    if (text.length > 0) event.system.push({ type: "text", text })
  }
}

/**
 * Bridges `experimental.chat.messages.transform` onto the 2.x `context` hook. The hook runs on the
 * translated 1.x conversation; its additions are written back to the request's last user message
 * (or the system prompt when they do not belong to a user turn).
 */
export async function registerMessagesTransform(
  context: V2PluginContext,
  handler: MessagesTransformHook,
  warn: (message: string) => void,
): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    let views: V1MessageView[]
    try {
      views = await buildV1Messages(context, event.sessionID)
    } catch (error) {
      warn(`messages.transform bridge skipped: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const before = views.map((view) => joinText(view.parts))
    const output = { messages: views }
    await handler({}, output)
    applyDelta(event, before, output.messages)
  })
}

import { isRecord } from "../../shared/record-type-guard"
import type { V2Event } from "../context-types"
import type { V1Event } from "./translate-events"

type Step = { readonly info: Record<string, unknown>; readonly tools: Map<string, Record<string, unknown>> }

/** Retain only the active step, never token deltas or completed session history. */
export function createMessageEvents(now: () => number = Date.now) {
  const steps = new Map<string, Step>()
  return {
    clear: () => steps.clear(),
    translate(event: V2Event): V1Event[] {
      const data = event.data
      if (!isRecord(data) || typeof data.sessionID !== "string") return []
      const sessionID = data.sessionID
      if (event.type === "session.deleted" || event.type.startsWith("session.execution.")) {
        steps.delete(sessionID)
        return []
      }
      const messageID = data.assistantMessageID
      if (typeof messageID !== "string") return []
      if (event.type === "session.step.started") {
        const model = isRecord(data.model) ? data.model : {}
        const info = {
          id: messageID, sessionID, role: "assistant", agent: data.agent, mode: data.agent,
          providerID: model.providerID, modelID: model.id, variant: model.variant,
          time: { created: data.started ?? now() },
        }
        steps.set(sessionID, { info, tools: new Map() })
        return [{ type: "message.updated", properties: { sessionID, info } }]
      }
      const step = steps.get(sessionID)
      const info = step?.info ?? { id: messageID, sessionID, role: "assistant" }
      const part = (fields: Record<string, unknown>): V1Event[] => [{
        type: "message.part.updated", properties: { sessionID, info, part: { sessionID, messageID, role: "assistant", ...fields } },
      }]
      if (event.type === "session.step.ended" || event.type === "session.step.failed") {
        steps.delete(sessionID)
        const error = isRecord(data.error) ? data.error : undefined
        return [{ type: "message.updated", properties: { sessionID, info: {
          ...info, finish: data.finish, cost: data.cost ?? 0, tokens: data.tokens,
          time: { ...(isRecord(info.time) ? info.time : { created: now() }), completed: now() },
          ...(error ? { error: { name: error.type, data: { message: error.message, statusCode: error.status } } } : {}),
        } } }]
      }
      if (event.type === "session.text.ended" || event.type === "session.reasoning.ended") {
        return part({ id: `${messageID}:${data.ordinal}`, type: event.type === "session.text.ended" ? "text" : "reasoning", text: data.text })
      }
      if (event.type === "session.tool.input.started" && typeof data.id === "string") {
        step?.tools.set(data.id, { name: data.name })
        return []
      }
      if (!event.type.startsWith("session.tool.") || typeof data.id !== "string") return []
      const tool = step?.tools.get(data.id)
      if (event.type === "session.tool.called") {
        const running = { ...tool, input: data.input }
        step?.tools.set(data.id, running)
        return part({ id: data.id, callID: data.id, type: "tool", tool: tool?.name, state: { status: "running", input: data.input } })
      }
      if (event.type === "session.tool.progress") {
        return part({ id: data.id, callID: data.id, type: "tool", tool: tool?.name, state: { status: "running", input: tool?.input, metadata: data.metadata } })
      }
      if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        step?.tools.delete(data.id)
        // V1 background progress counts terminal tool parts again; completion is represented by step.ended instead.
        return []
      }
      return []
    },
  }
}

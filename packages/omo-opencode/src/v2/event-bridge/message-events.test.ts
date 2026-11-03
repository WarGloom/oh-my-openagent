import { describe, expect, test } from "bun:test"
import { createMessageEvents } from "./message-events"
import { toV1Events } from "./translate-events"

describe("native message events", () => {
  test("carries assistant identity, usage and errors across a native step", () => {
    const messages = createMessageEvents(() => 200)
    const data = { sessionID: "s", assistantMessageID: "m" }
    messages.translate({ type: "session.step.started", data: { ...data, started: 100, agent: "atlas", model: { providerID: "p", id: "model", variant: "high" } } })
    const tokens = { input: 4, output: 5, reasoning: 2, cache: { read: 1, write: 0 } }
    const [event] = messages.translate({ type: "session.step.failed", data: { ...data, tokens, cost: 0.3, error: { type: "provider.auth", message: "denied", status: 401 } } })
    expect(event?.properties.info).toMatchObject({ id: "m", role: "assistant", sessionID: "s", agent: "atlas", providerID: "p", modelID: "model", variant: "high", tokens, cost: 0.3, time: { created: 100, completed: 200 }, error: { name: "provider.auth", data: { message: "denied", statusCode: 401 } } })
    const [next] = messages.translate({ type: "session.step.ended", data: { sessionID: "s", assistantMessageID: "next" } })
    expect(next?.properties.info).not.toHaveProperty("agent")
  })

  test("emits full text and deduplicatable running tool progress, not token fragments or terminal recounts", () => {
    const messages = createMessageEvents()
    const data = { sessionID: "s", assistantMessageID: "m" }
    messages.translate({ type: "session.step.started", data: { ...data, agent: "atlas", model: { providerID: "p", id: "model" } } })
    messages.translate({ type: "session.tool.input.started", data: { ...data, id: "call", name: "read" } })
    const [called] = messages.translate({ type: "session.tool.called", data: { ...data, id: "call", input: { path: "a" } } })
    const [progress] = messages.translate({ type: "session.tool.progress", data: { ...data, id: "call", metadata: { lines: 20 } } })
    expect(called?.properties.part).toMatchObject({ id: "call", tool: "read", type: "tool", state: { status: "running", input: { path: "a" } } })
    expect(progress?.properties).toMatchObject({ info: { role: "assistant" }, part: { id: "call", sessionID: "s", messageID: "m", tool: "read", state: { status: "running", metadata: { lines: 20 } } } })
    expect(messages.translate({ type: "session.text.delta", data: { ...data, ordinal: 0, delta: "a" } })).toEqual([])
    expect(messages.translate({ type: "session.text.ended", data: { ...data, ordinal: 0, text: "answer" } })[0]?.properties.part).toMatchObject({ type: "text", text: "answer", messageID: "m" })
    expect(messages.translate({ type: "session.tool.success", data: { ...data, id: "call" } })).toEqual([])
    messages.translate({ type: "session.execution.succeeded", data })
    expect(messages.translate({ type: "session.step.ended", data })[0]?.properties.info).not.toHaveProperty("agent")
  })

  test("preserves native permission replies and retry timing in the V1 protocol", () => {
    const sessions = { parentOf: () => undefined }
    expect(toV1Events({ type: "permission.asked", data: { sessionID: "s", id: "per", action: "shell", resources: ["ls"], save: ["ls *"] } }, sessions)[0]?.properties).toMatchObject({ id: "per", permission: "shell", patterns: ["ls"], always: ["ls *"] })
    expect(toV1Events({ type: "permission.replied", data: { sessionID: "s", requestID: "per", reply: "reject" } }, sessions)[0]?.properties).toEqual({ sessionID: "s", requestID: "per", reply: "reject" })
    expect(toV1Events({ type: "session.retry.scheduled", data: { sessionID: "s", attempt: 2, at: 900, error: { type: "provider.rate-limit", message: "retry" } } }, sessions)[0]?.properties.status).toEqual({ type: "retry", attempt: 2, next: 900, message: "retry" })
  })
})

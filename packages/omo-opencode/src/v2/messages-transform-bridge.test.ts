import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { V2ContextHookEvent } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"

const MODEL = { providerID: "anthropic", id: "claude-opus-4" }

function contextEvent(messages: V2ContextHookEvent["messages"]): V2ContextHookEvent {
  return { sessionID: "ses_1", agent: "Sisyphus", model: MODEL, system: [], messages, options: {} }
}

type MessagesHook = NonNullable<Hooks["experimental.chat.messages.transform"]>

async function runWith(messages: V2ContextHookEvent["messages"], hook: unknown): Promise<V2ContextHookEvent> {
  const fake = createFakePluginContext()
  await installSessionHooks(fake.context, { "experimental.chat.messages.transform": hook as MessagesHook } as Hooks, { warn: () => {} })
  return fake.triggerContext(contextEvent(messages))
}

describe("messages transform bridge", () => {
  describe("#given an additive context injector", () => {
    it("#when it appends text to the last user turn #then the request's last user message carries it", async () => {
      // given
      const hook = async (_input: unknown, output: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) => {
        output.messages.at(-1)?.parts.push({ type: "text", text: "[directory context]" })
      }

      // when
      const event = await runWith([{ role: "user", content: [{ type: "text", text: "hi" }] }], hook)

      // then
      expect(event.messages[0]?.content).toEqual([
        { type: "text", text: "hi" },
        { type: "text", text: "[directory context]" },
      ])
    })
  })

  describe("#given a tool-pair repair", () => {
    it("#when the hook settles an unpaired tool call to error #then a paired tool-result message reaches event.messages", async () => {
      // given
      const messages = [
        { role: "assistant", id: "m1", content: [{ type: "tool-call", id: "c1", name: "shell", input: { command: "sleep 1" } }] },
      ]
      const hook = async (_input: unknown, output: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) => {
        for (const message of output.messages) {
          for (const part of message.parts) {
            if (part.type === "tool") {
              const state = part.state as Record<string, unknown>
              state.status = "error"
              state.error = "[Tool execution was interrupted before it produced output]"
            }
          }
        }
      }

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages).toEqual([
        { id: "m1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "shell", input: { command: "sleep 1" } }] },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "c1", name: "shell", result: { type: "error", value: "[Tool execution was interrupted before it produced output]" } }],
        },
      ])
    })
  })

  describe("#given an assistant-tail recovery", () => {
    it("#when the hook appends a user recovery turn after a trailing assistant #then it reaches event.messages as a user message", async () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "do it" }] },
        { role: "assistant", id: "m1", content: [{ type: "text", text: "done" }] },
      ]
      const hook = async (_input: unknown, output: { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }) => {
        if (output.messages.at(-1)?.info.role === "assistant") {
          output.messages.push({ info: { role: "user" }, parts: [{ type: "text", text: "[internal] Continue from the previous assistant state." }] })
        }
      }

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "[internal] Continue from the previous assistant state." }] })
      expect(event.messages[1]?.role).toBe("assistant")
    })
  })

  describe("#given a settled tool call and no hook change", () => {
    it("#when the request already pairs the call #then the original tool-result is re-emitted unchanged", async () => {
      // given
      const messages = [
        { role: "assistant", id: "m1", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "/a" } }] },
        { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "content", value: [{ type: "text", text: "const a = 1" }] } }] },
      ]
      const hook = async () => {}

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages).toEqual(messages)
    })
  })

  describe("#given an unpaired tool call the hook leaves alone", () => {
    it("#when nothing repairs it (e.g. a subagent session) #then no tool-result is synthesized", async () => {
      // given
      const messages = [
        { role: "assistant", id: "m1", content: [{ type: "tool-call", id: "c1", name: "shell", input: {} }] },
      ]
      const hook = async () => {}

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages).toEqual([{ id: "m1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "shell", input: {} }] }])
    })
  })
})

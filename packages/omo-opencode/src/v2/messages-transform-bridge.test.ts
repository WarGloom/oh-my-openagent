import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { V2ContextHookEvent } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"
import { createMessagesTransformHandler } from "../plugin/messages-transform"

function signedConversation(): V2ContextHookEvent["messages"] {
  return [
    {
      role: "user",
      id: "u1",
      content: [
        {
          type: "text",
          text: "delegate",
          cache: { type: "ephemeral" },
          providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        { type: "media", media: { mediaType: "image/png", source: { type: "base64", data: "aW1hZ2U=" } } },
      ],
      metadata: { custom: "user" },
    },
    {
      role: "assistant",
      id: "a1",
      content: [
        {
          type: "reasoning",
          text: "thought",
          encrypted: "signature-example",
          providerMetadata: { anthropic: { signature: "signature-example" } },
        },
        { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedData: "redacted-data" } } },
        { type: "text", text: "checking", cache: { type: "ephemeral" } },
        {
          type: "tool-call",
          id: "c1",
          name: "task",
          input: { prompt: "READY" },
          providerMetadata: { custom: { call: true } },
        },
      ],
      metadata: { custom: "assistant" },
    },
    {
      role: "tool",
      id: "t1",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "task",
          result: { type: "content", value: [{ type: "text", text: "READY" }] },
          providerMetadata: { custom: { result: true } },
        },
      ],
      metadata: { custom: "result" },
    },
  ]
}

const MODEL = { providerID: "anthropic", id: "claude-opus-4" }

function contextEvent(messages: V2ContextHookEvent["messages"]): V2ContextHookEvent {
  return { sessionID: "ses_1", agent: "Sisyphus", model: MODEL, system: [], messages, options: {} }
}

type MessagesHook = NonNullable<Hooks["experimental.chat.messages.transform"]>

async function runWith(messages: V2ContextHookEvent["messages"], hook: unknown): Promise<V2ContextHookEvent> {
  const fake = createFakePluginContext()
  await installSessionHooks(fake.context, { "experimental.chat.messages.transform": hook as MessagesHook } as Hooks, {
    warn: () => {},
  })
  return fake.triggerContext(contextEvent(messages))
}

describe("messages transform bridge", () => {
  it("#given delegation followed by a host system update #when the V1 handler runs #then recovery follows the result and update", async () => {
    // given
    const messages = signedConversation()
    const update = {
      role: "system",
      id: "mcp-update",
      content: [{ type: "text", text: "new MCP guidance" }],
      metadata: { notice: "instructions", instructionSources: ["core/mcp-guidance"] },
    }
    messages.push(update)

    // when
    const event = await runWith(messages, createMessagesTransformHandler({ hooks: {} }))

    // then
    expect(event.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system", "user"])
    expect(event.messages[2]?.content).toEqual(signedConversation()[2]?.content)
    expect(event.messages[3]).toBe(update)
    expect(event.messages[4]?.id).toBe("a1_prefill_recovery")
  })

  describe("#given provider fields and a settled tool result", () => {
    it("#when the handler makes no changes #then every field and original object survives", async () => {
      // given
      const messages = signedConversation()
      const originals = [...messages]
      const snapshot = structuredClone(messages)

      // when
      const event = await runWith(messages, async () => {})

      // then
      expect(event.messages).toEqual(snapshot)
      for (const [index, original] of originals.entries()) {
        expect(event.messages[index]).toBe(original)
      }
    })

    it("#when a hook appends to the last user message #then only that message changes", async () => {
      // given
      const messages = signedConversation()
      const originals = [...messages]
      const snapshot = structuredClone(messages)
      const hook = async (
        _input: unknown,
        output: { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> },
      ) => {
        output.messages.findLast((message) => message.info.role === "user")?.parts.push({ type: "text", text: "extra" })
      }

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages[0]).not.toBe(originals[0])
      const userContent = snapshot[0]?.content
      expect(event.messages[0]?.content).toEqual([
        ...(Array.isArray(userContent) ? userContent : []),
        { type: "text", text: "extra" },
      ])
      expect(event.messages.slice(1)).toEqual(snapshot.slice(1))
      expect(event.messages[1]).toBe(originals[1])
      expect(event.messages[2]).toBe(originals[2])
    })
  })

  it("#given a fatal handler error #when context runs #then the context hook rejects with that error", async () => {
    // given
    const failure = new Error("side context unavailable")

    // when / then
    await expect(
      runWith([{ role: "user", content: [{ type: "text", text: "hi" }] }], async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

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
        {
          role: "assistant",
          id: "m1",
          content: [{ type: "tool-call", id: "c1", name: "shell", input: { command: "sleep 1" } }],
        },
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
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "shell", input: { command: "sleep 1" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c1",
              name: "shell",
              result: { type: "error", value: "[Tool execution was interrupted before it produced output]" },
            },
          ],
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
      const hook = async (
        _input: unknown,
        output: { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> },
      ) => {
        if (output.messages.at(-1)?.info.role === "assistant") {
          output.messages.push({
            info: { role: "user" },
            parts: [{ type: "text", text: "[internal] Continue from the previous assistant state." }],
          })
        }
      }

      // when
      const event = await runWith(messages, hook)

      // then
      expect(event.messages.at(-1)).toEqual({
        role: "user",
        content: [{ type: "text", text: "[internal] Continue from the previous assistant state." }],
      })
      expect(event.messages[1]?.role).toBe("assistant")
    })
  })

  describe("#given a settled tool call and no hook change", () => {
    it("#when the request already pairs the call #then the original tool-result is re-emitted unchanged", async () => {
      // given
      const messages = [
        {
          role: "assistant",
          id: "m1",
          content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "/a" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c1",
              name: "read",
              result: { type: "content", value: [{ type: "text", text: "const a = 1" }] },
            },
          ],
        },
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
      expect(event.messages).toEqual([
        { id: "m1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "shell", input: {} }] },
      ])
    })
  })

  describe("#given a context injector that prepends text", () => {
    it("#when it inserts context before the user's text #then the request keeps [context, prompt] order with the prompt once", async () => {
      // given: the injector puts synthetic context before the first real user text
      const hook = async (_input: unknown, output: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) => {
        output.messages.at(-1)?.parts.unshift({ type: "text", text: "<context>C</context>" })
      }

      // when
      const event = await runWith([{ role: "user", content: [{ type: "text", text: "P" }] }], hook)

      // then
      expect(event.messages[0]?.content).toEqual([
        { type: "text", text: "<context>C</context>" },
        { type: "text", text: "P" },
      ])
    })
  })

  describe("#given an injector that prepends whole messages", () => {
    it("#when it inserts two messages before the conversation #then event.messages is [inserted1, inserted2, ...original]", async () => {
      // given
      const hook = async (
        _input: unknown,
        output: { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> },
      ) => {
        output.messages.unshift(
          { info: { role: "user" }, parts: [{ type: "text", text: "parent-1" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "parent-2" }] },
        )
      }

      // when
      const event = await runWith([{ role: "user", content: [{ type: "text", text: "original" }] }], hook)

      // then
      expect(event.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "parent-1" }] },
        { role: "user", content: [{ type: "text", text: "parent-2" }] },
        { role: "user", content: [{ type: "text", text: "original" }] },
      ])
    })
  })
})

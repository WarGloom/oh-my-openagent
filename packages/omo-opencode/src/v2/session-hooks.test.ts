import { describe, expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type {
  V2CompactionHookEvent,
  V2ContextHookEvent,
  V2ModelRequestHookEvent,
  V2PromptHookEvent,
} from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"
import { createChatParamsHandler } from "../plugin/chat-params"
import { createChatHeadersHandler } from "../plugin/chat-headers"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../shared/internal-initiator-marker"
import { setSessionPromptParams, clearSessionPromptParams } from "../shared/session-prompt-params-state"
import { createSystemTransformHandler } from "../plugin/system-transform"
import { clearSisyphusRuntimePromptContext, setSisyphusRuntimePromptContext } from "../agents/sisyphus-runtime-prompt-reconciler"

const MODEL = { providerID: "anthropic", id: "claude-opus-4" }

function promptEvent(overrides: Partial<V2PromptHookEvent> = {}): V2PromptHookEvent {
  return { sessionID: "ses_1", messageID: "msg_1", prompt: { text: "hello" }, ...overrides }
}

function contextEvent(overrides: Partial<V2ContextHookEvent> = {}): V2ContextHookEvent {
  return { sessionID: "ses_1", agent: "Sisyphus", model: MODEL, system: [], messages: [], options: {}, ...overrides }
}

function modelRequestEvent(overrides: Partial<V2ModelRequestHookEvent> = {}): V2ModelRequestHookEvent {
  return { sessionID: "ses_1", agent: "Sisyphus", model: MODEL, kind: "primary", headers: {}, ...overrides }
}

function compactionEvent(overrides: Partial<V2CompactionHookEvent> = {}): V2CompactionHookEvent {
  return { sessionID: "ses_1", agent: "Sisyphus", model: MODEL, system: [], messages: [], options: {}, ...overrides }
}

describe("installSessionHooks", () => {
  describe("#given a chat.message hook", () => {
    it("#when a prompt is admitted #then an edited first text part rewrites the prompt text", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["chat.message"]> = async (input, output) => {
        expect(input.sessionID).toBe("ses_1")
        output.parts[0].text = "hello (reviewed)"
      }
      await installSessionHooks(fake.context, { "chat.message": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerPrompt(promptEvent())

      // then
      expect(event.prompt.text).toBe("hello (reviewed)")
    })

    it("#when a handler appends a second text part #then every text part reaches the prompt text in order", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["chat.message"]> = async (_input, output) => {
        output.parts.push({ type: "text", text: "<ultrawork-mode>" })
      }
      await installSessionHooks(fake.context, { "chat.message": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerPrompt(promptEvent({ prompt: { text: "do the work" } }))

      // then
      expect(event.prompt.text).toBe("do the work\n<ultrawork-mode>")
    })

    it("#when a handler reads input.agent #then it gets the session agent from session.get", async () => {
      // given
      const fake = createFakePluginContext({ sessionAgent: "Atlas" })
      let seen: string | undefined
      const hook: NonNullable<Hooks["chat.message"]> = async (input) => {
        seen = input.agent
      }
      await installSessionHooks(fake.context, { "chat.message": hook } as Hooks, { warn: () => {} })

      // when
      await fake.triggerPrompt(promptEvent())

      // then
      expect(seen).toBe("Atlas")
    })

    it("#when the session.get read fails #then the handler still runs with agent undefined", async () => {
      // given
      const fake = createFakePluginContext({ sessionAgent: "Atlas" })
      const context = { ...fake.context, session: { ...fake.context.session, get: async () => { throw new Error("boom") } } }
      let seen: { called: boolean; agent: string | undefined } = { called: false, agent: "unset" }
      const hook: NonNullable<Hooks["chat.message"]> = async (input) => {
        seen = { called: true, agent: input.agent }
      }
      await installSessionHooks(context, { "chat.message": hook } as Hooks, { warn: () => {} })

      // when
      await fake.triggerPrompt(promptEvent())

      // then
      expect(seen).toEqual({ called: true, agent: undefined })
    })
  })

  describe("#given a chat.params hook", () => {
    it("#when native model limits and stored request settings apply #then the real handler normalizes the host request", async () => {
      // given
      const fake = createFakePluginContext({
        models: [{ ...MODEL, modelID: MODEL.id, name: MODEL.id, status: "active", enabled: true,
          capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high" }],
          limit: { context: 64_000, output: 2_048 } }],
        providers: [{ id: MODEL.providerID, name: "Anthropic", activation: "auto" }],
      })
      setSessionPromptParams("ses_1", { maxOutputTokens: 9_000, options: { customSetting: "selected" } })
      const dispose = await installSessionHooks(fake.context, { "chat.params": createChatParamsHandler() }, { warn: () => {} })
      try {
        // when
        const event = await fake.triggerContext(contextEvent({ options: { maxTokens: 12_000, hostSetting: "retained" } }))
        // then
        expect(event.options).toMatchObject({ maxTokens: 2_048, customSetting: "selected", hostSetting: "retained" })
      } finally {
        clearSessionPromptParams("ses_1")
        await dispose()
      }
    })

    it("#when the context is built #then temperature, maxTokens and extra options flow into the request options", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["chat.params"]> = async (input, output) => {
        expect(input.agent).toBe("Sisyphus")
        output.temperature = 0.2
        output.maxOutputTokens = 8_000
        output.options.reasoningEffort = "high"
      }
      await installSessionHooks(fake.context, { "chat.params": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerContext(contextEvent())

      // then
      expect(event.options).toEqual({ temperature: 0.2, maxTokens: 8_000, reasoningEffort: "high" })
    })
  })

  describe("#given a chat.headers hook", () => {
    it("#when Copilot requests follow an internal native message #then the real header handler marks its initiator", async () => {
      // given
      const model = { providerID: "github-copilot", id: "gpt-5" }
      const fake = createFakePluginContext({ sessionMessages: [
        { id: "msg_internal_copilot", type: "synthetic", text: `continue ${OMO_INTERNAL_INITIATOR_MARKER}`, time: { created: 1 } },
        { id: "msg_assistant", type: "assistant", model, agent: "Sisyphus", content: [], time: { created: 2 } },
      ] })
      const ctx = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
      const dispose = await installSessionHooks(fake.context, { "chat.headers": createChatHeadersHandler({ ctx }) }, { warn: () => {} })
      try {
        // when
        const event = await fake.triggerModelRequest(modelRequestEvent({ model }))
        // then
        expect(event.headers["x-initiator"]).toBe("agent")
      } finally {
        await dispose()
      }
    })

    it("#when a non-primary model request runs #then the headers are applied to it", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["chat.headers"]> = async (_input, output) => {
        output.headers["x-initiator"] = "agent"
      }
      await installSessionHooks(fake.context, { "chat.headers": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerModelRequest(modelRequestEvent({ kind: "title" }))

      // then
      expect(event.headers).toEqual({ "x-initiator": "agent" })
    })
  })

  describe("#given an experimental.chat.system.transform hook", () => {
    it("#when reconciliation changes existing text #then V2 retains part identity, metadata, order, and appended guidance", async () => {
      // given
      setSisyphusRuntimePromptContext({
        configuredModel: "openai/old",
        bakedPrompt: "original-core",
        rebuildPromptForModel: () => "updated-core",
      })
      const fake = createFakePluginContext()
      const hook = createSystemTransformHandler({ ultrawork: true }, () => "guidance")
      const first = { type: "text", text: "prefix original-core suffix", metadata: { source: "agent" } }
      const second = { type: "text", text: "other", metadata: { source: "host" } }
      try {
        await installSessionHooks(fake.context, { "experimental.chat.system.transform": hook } as Hooks, { warn: () => {} })

        // when
        const event = await fake.triggerContext(contextEvent({ system: [first, second] }))

        // then
        expect(event.system).toEqual([
          { type: "text", text: "prefix updated-core suffix", metadata: { source: "agent" } },
          { type: "text", text: "other", metadata: { source: "host" } },
          { type: "text", text: "guidance" },
        ])
        expect(event.system[0]).toBe(first)
        expect(event.system[1]).toBe(second)
      } finally {
        clearSisyphusRuntimePromptContext()
      }
    })

    it("#when the context is built #then new system entries are appended as text parts without duplicating the seed", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["experimental.chat.system.transform"]> = async (_input, output) => {
        output.system.push("Base prompt")
        output.system.push("Focus on correctness.")
      }
      await installSessionHooks(fake.context, { "experimental.chat.system.transform": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerContext(contextEvent({ system: [{ type: "text", text: "Base prompt" }] }))

      // then
      expect(event.system).toEqual([
        { type: "text", text: "Base prompt" },
        { type: "text", text: "Focus on correctness." },
      ])
    })
  })

  describe("#given an experimental.session.compacting hook", () => {
    it("#when it only adds context #then the context rides on the compaction system prompt", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["experimental.session.compacting"]> = async (_input, output) => {
        output.context.push("preserve the todo list")
      }
      await installSessionHooks(fake.context, { "experimental.session.compacting": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerCompaction(compactionEvent())

      // then
      expect(event.result).toBeUndefined()
      expect(event.system).toEqual([{ type: "text", text: "preserve the todo list" }])
    })

    it("#when it replaces the prompt #then the compaction result summary is set and the model request is skipped", async () => {
      // given
      const fake = createFakePluginContext()
      const hook: NonNullable<Hooks["experimental.session.compacting"]> = async (_input, output) => {
        output.prompt = "Summarize everything."
        output.context.push("keep the plan")
      }
      await installSessionHooks(fake.context, { "experimental.session.compacting": hook } as Hooks, { warn: () => {} })

      // when
      const event = await fake.triggerCompaction(compactionEvent())

      // then
      expect(event.result).toEqual({ summary: "Summarize everything.\n\nkeep the plan" })
    })
  })

  describe("#given a hooks object", () => {
    it("#when only some request hooks are present #then only those register and the disposer unregisters them", async () => {
      // given
      const fake = createFakePluginContext()
      const hooks = {
        "chat.params": async () => {},
        "experimental.session.compacting": async () => {},
      } as Hooks

      // when
      const dispose = await installSessionHooks(fake.context, hooks, { warn: () => {} })

      // then
      expect(fake.sessionHookCount()).toBe(2)
      await dispose()
      expect(fake.sessionHookCount()).toBe(0)
    })
  })
})

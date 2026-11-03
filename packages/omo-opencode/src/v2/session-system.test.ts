import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { V2ContextHookEvent, V2PluginContext, V2StorageDomain } from "./context-types"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"

function contextEvent(sessionID = "child"): V2ContextHookEvent {
  return { sessionID, agent: "worker", model: { providerID: "test", id: "model" }, system: [{ type: "text", text: "host" }], messages: [], options: {} }
}

function createStorage(): V2StorageDomain {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }),
  }
}

async function mount(context: V2PluginContext) {
  const received = Promise.withResolvers<PluginInput>()
  const cleanup = await createV2Setup({ serverPlugin: async (input) => { received.resolve(input); return {} } })(context)
  return { client: (await received.promise).client, cleanup }
}

describe("V2 session system text", () => {
  it("includes the supplied system text in the first model context before prompt dispatch returns", async () => {
    // given
    const fake = createFakePluginContext()
    const requests: V2ContextHookEvent[] = []
    const context = { ...fake.context, session: { ...fake.context.session, prompt: async () => { requests.push(await fake.triggerContext(contextEvent())) } } }
    const { client, cleanup } = await mount(context)
    const system = "loaded skill body\ncategory append"
    try {
      // when
      const result = await client.session.promptAsync({ path: { id: "child" }, body: { system, parts: [{ type: "text", text: "work" }] } })
      // then
      expect(result.error).toBeUndefined()
      expect(requests.map((request) => request.system)).toEqual([[{ type: "text", text: "host" }, { type: "text", text: system }]])
    } finally {
      await cleanup()
    }
  })

  it("keeps, replaces, and clears system text without changing another session", async () => {
    // given
    const fake = createFakePluginContext()
    const { client, cleanup } = await mount(fake.context)
    const parts = [{ type: "text" as const, text: "continue", synthetic: true }]
    try {
      await client.session.promptAsync({ path: { id: "other" }, body: { system: "other instructions", parts } })
      await client.session.promptAsync({ path: { id: "child" }, body: { system: "first instructions", parts } })
      // when
      const observed = []
      for (const body of [{ parts }, { system: "replacement", parts }, { parts }, { system: "", parts }]) {
        await client.session.promptAsync({ path: { id: "child" }, body })
        observed.push((await fake.triggerContext(contextEvent())).system.map((part) => part.text))
      }
      const other = await fake.triggerContext(contextEvent("other"))
      // then
      expect(observed).toEqual([["host", "first instructions"], ["host", "replacement"], ["host", "replacement"], ["host"]])
      expect(other.system.map((part) => part.text)).toEqual(["host", "other instructions"])
    } finally {
      await cleanup()
    }
  })

  it("applies stored text to every later model request and after plugin reload", async () => {
    // given
    const storage = createStorage()
    const before = createFakePluginContext()
    const first = await mount({ ...before.context, storage })
    await first.client.session.promptAsync({ path: { id: "child" }, body: { system: "persistent instructions", parts: [{ type: "text", text: "work" }] } })
    await first.cleanup()
    const after = createFakePluginContext()
    const second = await mount({ ...after.context, storage })
    try {
      // when
      const restored = await after.triggerContext(contextEvent())
      await second.client.session.promptAsync({ path: { id: "child" }, body: { parts: [{ type: "text", text: "continue" }] } })
      const continued = await after.triggerContext(contextEvent())
      // then
      expect(restored.system.map((part) => part.text)).toEqual(["host", "persistent instructions"])
      expect(continued.system).toEqual(restored.system)
      expect(before.sessionHookCount()).toBe(0)
    } finally {
      await second.cleanup()
    }
  })

  it("does not dispatch a prompt when its system text cannot be persisted", async () => {
    // given
    const fake = createFakePluginContext()
    const storage = { ...createStorage(), set: async () => { throw new Error("storage unavailable") } }
    const { client, cleanup } = await mount({ ...fake.context, storage })
    try {
      // when
      const result = await client.session.promptAsync({ path: { id: "child" }, body: { system: "required instructions", parts: [{ type: "text", text: "work" }] } })
      // then
      expect(result.error).toMatchObject({ data: { message: "storage unavailable" } })
      expect(fake.sessionCalls).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("removes its context hook when setup fails", async () => {
    // given
    const fake = createFakePluginContext()
    const failure = new Error("plugin initialization failed")
    const setup = createV2Setup({ serverPlugin: async () => { throw failure } })
    // when
    await expect(setup(fake.context)).rejects.toBe(failure)
    // then
    expect(fake.sessionHookCount()).toBe(0)
  })
})

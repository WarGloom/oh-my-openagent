import { describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createSessionNamespace } from "./session-namespace"
import type { V2PermissionRule } from "../context-types"

describe("V2 prompt tool restrictions", () => {
  it("applies native permissions before prompt admission and preserves unrelated rules", async () => {
    // given
    const fake = createFakePluginContext()
    let permissions: V2PermissionRule[] = [{ action: "external_directory", resource: "*", effect: "deny" }]
    const admitted: unknown[] = []
    const context = { ...fake.context, session: { ...fake.context.session,
      get: async ({ sessionID }: { sessionID: string }) => ({ ...await fake.context.session.get({ sessionID }), permissions }),
      update: async (input: { permissions?: readonly { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] }) => {
        permissions = input.permissions?.map((rule) => ({ ...rule })) ?? permissions
      },
      prompt: async () => { admitted.push(permissions) },
    } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    await session.promptAsync({ path: { id: "child" }, body: { tools: { task: false, call_omo_agent: false, write: false, patch: false, bash: false, read: true }, parts: [{ type: "text", text: "go" }] } })
    // then
    expect(admitted).toEqual([[
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]])
  })

  it("does not admit a prompt if native permission update fails", async () => {
    // given
    const fake = createFakePluginContext()
    const context = { ...fake.context, session: { ...fake.context.session, update: async () => { throw new Error("permission update failed") } } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = await session.promptAsync({ path: { id: "child" }, body: { tools: { task: false }, parts: [{ type: "text", text: "go" }] } })
    // then
    expect(result.error?.data.message).toBe("permission update failed")
    expect(fake.sessionCalls).toEqual([])
  })

  it.each([
    { tools: { write: false, edit: true }, action: "edit" },
    { tools: { edit: true, write: false }, action: "edit" },
    { tools: { task: false, call_omo_agent: true }, action: "subagent" },
    { tools: { call_omo_agent: true, task: false }, action: "subagent" },
    { tools: { call_omo_agent: false }, action: "subagent" },
  ])("keeps aliases denied for $tools", async ({ tools, action }) => {
    // given
    const fake = createFakePluginContext()
    let permissions: readonly V2PermissionRule[] = []
    const context = { ...fake.context, session: { ...fake.context.session,
      update: async (input: { permissions?: readonly V2PermissionRule[] }) => { permissions = input.permissions ?? [] },
    } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    await session.promptAsync({ path: { id: "child" }, body: { tools, parts: [{ type: "text", text: "go" }] } })
    // then
    expect(permissions).toEqual([{ action, resource: "*", effect: "deny" }])
  })

  it("does not widen native wildcard or resource restrictions when a tool is enabled", async () => {
    // given
    const original: V2PermissionRule[] = [
      { action: "read", resource: "*", effect: "ask" },
      { action: "read", resource: "/secrets/*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]
    let permissions: readonly V2PermissionRule[] = original
    const fake = createFakePluginContext({ sessionInfo: { permissions: original } })
    const context = { ...fake.context, session: { ...fake.context.session,
      update: async (input: { permissions?: readonly V2PermissionRule[] }) => { permissions = input.permissions ?? permissions },
    } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    await session.promptAsync({ path: { id: "child" }, body: { tools: { read: true, bash: true, task: false }, parts: [{ type: "text", text: "go" }] } })
    // then
    expect(permissions).toEqual([...original, { action: "subagent", resource: "*", effect: "deny" }])
  })

  it("preserves native rules and does not accumulate duplicate denies on resumed prompts", async () => {
    // given
    const original: V2PermissionRule[] = [{ action: "read", resource: "/private/*", effect: "deny" }]
    let permissions: readonly V2PermissionRule[] = original
    const fake = createFakePluginContext()
    const context = { ...fake.context, session: { ...fake.context.session,
      get: async ({ sessionID }: { sessionID: string }) => ({ ...await fake.context.session.get({ sessionID }), permissions }),
      update: async (input: { permissions?: readonly V2PermissionRule[] }) => { permissions = input.permissions ?? permissions },
    } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    const prompt = { path: { id: "child" }, body: { tools: { task: false, write: false }, parts: [{ type: "text", text: "go" }] } }
    // when
    await session.promptAsync(prompt)
    await session.promptAsync(prompt)
    // then
    expect(permissions).toEqual([...original, { action: "subagent", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" }])
  })
})

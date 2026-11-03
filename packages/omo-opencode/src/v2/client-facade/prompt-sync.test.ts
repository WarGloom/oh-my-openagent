import { describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createSessionNamespace } from "./session-namespace"
import type { V2SessionMessage } from "../context-types"

describe("V2 synchronous prompt", () => {
  it("waits for native completion and returns only the new assistant response", async () => {
    // given
    const old: V2SessionMessage = {
      type: "assistant",
      id: "old",
      agent: "worker",
      model: { providerID: "p", id: "m" },
      content: [{ type: "text", text: "old answer" }],
      time: { created: 1, completed: 2 },
    }
    const fresh: V2SessionMessage = { ...old, id: "fresh", content: [{ type: "text", text: "new answer" }] }
    const fake = createFakePluginContext()
    let messages: readonly V2SessionMessage[] = [old]
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const context = {
      ...fake.context,
      session: {
        ...fake.context.session,
        context: async () => messages,
        wait: async () => {
          entered.resolve()
          await complete.promise
          messages = [old, fresh]
        },
      },
    }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = session.prompt({ path: { id: "child" }, body: { parts: [{ type: "text", text: "question" }] } })
    await entered.promise
    complete.resolve()
    // then
    const response = (await result).data
    expect(response?.info).toMatchObject({ id: "fresh", role: "assistant" })
    expect(response?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["new answer"])
  }, 1000)

  it("does not return an older answer when the turn produces no assistant", async () => {
    // given
    const fake = createFakePluginContext()
    const session = createSessionNamespace(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = await session.prompt({
      path: { id: "child" },
      body: { parts: [{ type: "text", text: "question" }] },
    })
    // then
    expect(result.error).toBeDefined()
  })
})

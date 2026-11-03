import { afterEach, describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createClientFacade } from "./create-client-facade"
import { readSessionMessages, resetStorageClient, setStorageClient } from "../../tools/session-manager/storage"

afterEach(resetStorageClient)

describe("V2 session storage selection", () => {
  it("reads the facade session without a V1 database dependency", async () => {
    // given
    const fake = createFakePluginContext({
      sessionMessages: [{ type: "user", id: "native-message", text: "native history", time: { created: 1 } }],
    })
    const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    setStorageClient(client)
    // when
    const messages = await readSessionMessages("native-only-session", { limit: 1, fromEnd: true })
    // then
    expect(messages.map((message) => ({ id: message.id, text: message.parts[0]?.text }))).toEqual([
      { id: "native-message", text: "native history" },
    ])
  })

  it("propagates native session read errors instead of using legacy file storage", async () => {
    // given
    const fake = createFakePluginContext()
    const context = {
      ...fake.context,
      session: {
        ...fake.context.session,
        context: async () => {
          throw new Error("native store unavailable")
        },
      },
    }
    setStorageClient(createClientFacade(context, { tracker: createSessionTracker(), warn: () => {} }))
    // when / then
    await expect(readSessionMessages("native-only-session")).rejects.toThrow("native store unavailable")
  })
})

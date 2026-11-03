import { describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createClientFacade } from "./create-client-facade"
import { forEachSdkSessionMessagePage, getSdkSessionMessageWindow } from "../../tools/session-manager/sdk-storage"

describe("V2 facade message pagination", () => {
  it("lets the session SDK walk histories longer than two full pages without duplicates", async () => {
    // given
    const fake = createFakePluginContext({
      sessionMessages: Array.from({ length: 205 }, (_, i) => ({
        type: "user" as const,
        id: `msg_${i}`,
        text: String(i),
        time: { created: i },
      })),
    })
    const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    const pages: string[][] = []
    // when
    await forEachSdkSessionMessagePage(client, "child", (messages) => {
      pages.push(messages.map((message) => message.id))
    })
    // then
    expect(pages.map((page) => [page.length, page[0], page.at(-1)])).toEqual([
      [100, "msg_105", "msg_204"],
      [100, "msg_5", "msg_104"],
      [5, "msg_0", "msg_4"],
    ])
  })

  it("returns the oldest bounded window through the V1 cursor contract", async () => {
    // given
    const fake = createFakePluginContext({
      sessionMessages: Array.from({ length: 105 }, (_, i) => ({
        type: "user" as const,
        id: `msg_${i}`,
        text: String(i),
        time: { created: i },
      })),
    })
    const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const messages = await getSdkSessionMessageWindow(client, "child", { limit: 3, fromEnd: false })
    // then
    expect(messages.map((message) => message.id)).toEqual(["msg_0", "msg_1", "msg_2"])
  })
})

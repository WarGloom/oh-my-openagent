import { describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createSessionNamespace } from "./session-namespace"

describe("V2 facade attachments", () => {
  it("carries image data and PDF file URIs into native prompt files", async () => {
    // given
    const fake = createFakePluginContext()
    const session = createSessionNamespace(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    await session.promptAsync({
      path: { id: "child" },
      body: {
        parts: [
          { type: "text", text: "inspect", synthetic: true },
          { type: "file", url: "data:image/png;base64,aGVsbG8=", mime: "image/png", filename: "image.png" },
          { type: "file", url: "file:///tmp/report.pdf", mime: "application/pdf", filename: "report.pdf" },
        ],
      },
    })
    // then
    expect(fake.sessionCalls).toEqual([
      {
        kind: "prompt",
        input: {
          sessionID: "child",
          text: "inspect",
          delivery: "queue",
          resume: true,
          files: [
            { uri: "data:image/png;base64,aGVsbG8=", name: "image.png" },
            { uri: "file:///tmp/report.pdf", name: "report.pdf" },
          ],
        },
      },
    ])
  })

  it("admits an attachment-only prompt", async () => {
    // given
    const fake = createFakePluginContext()
    const session = createSessionNamespace(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = await session.promptAsync({
      path: { id: "child" },
      body: { parts: [{ type: "file", url: "file:///tmp/a.png" }] },
    })
    // then
    expect(result.error).toBeUndefined()
    expect(fake.sessionCalls).toEqual([
      {
        kind: "prompt",
        input: { sessionID: "child", text: "", files: [{ uri: "file:///tmp/a.png" }], delivery: "queue", resume: true },
      },
    ])
  })
})

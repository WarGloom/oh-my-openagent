import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginContext } from "../plugin/types"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createHashlineEditTool } from "../tools/hashline-edit/tools"
import { createFakePluginContext } from "./fake-plugin-context"
import { createClientFacade } from "./client-facade/create-client-facade"
import { createSessionTracker } from "./session-tracker"

it("formats the edited file through its native Session Location exactly once", async () => {
  // given
  const directory = await mkdtemp(join(tmpdir(), "omo-native-formatter-"))
  const filepath = join(directory, "sample.ts")
  let formatted = 0
  const fake = createFakePluginContext({ formatFile: async (input) => {
    expect(input).toEqual({ sessionID: "native_edit", filepath })
    expect(await Bun.file(filepath).text()).toBe("const dirty=1")
    formatted += 1
    await Bun.write(filepath, "const dirty = 1;\n")
    return true
  } })
  const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const tool = createHashlineEditTool(unsafeTestValue<PluginContext>({ client }))
  const context = unsafeTestValue<ToolContext>({ sessionID: "native_edit", messageID: "edit_message", agent: "Sisyphus", directory, abort: new AbortController().signal, ask: async () => {}, metadata: () => {} })
  try {
    // when
    const result = await tool.execute({ filePath: filepath, edits: [{ op: "append", lines: "const dirty=1" }] }, context)
    // then
    expect(result).toBe(`Updated ${filepath}`)
    expect(await Bun.file(filepath).text()).toBe("const dirty = 1;\n")
    expect(formatted).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

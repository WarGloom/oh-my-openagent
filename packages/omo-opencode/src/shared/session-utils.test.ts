import { afterEach, expect, it, mock, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import * as storage from "./opencode-storage-detection"
import * as messageDirectory from "./opencode-message-dir"
import { isCallerOrchestrator } from "./session-utils"

const directories: string[] = []
afterEach(() => {
  mock.restore()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each([
  { native: true, sqlite: false, agent: "atlas", expected: true },
  { native: true, sqlite: false, agent: "sisyphus", expected: false },
  { native: false, sqlite: true, agent: "atlas", expected: true },
  { native: false, sqlite: true, agent: "sisyphus", expected: false },
])(
  "#given SDK caller native=$native sqlite=$sqlite agent=$agent #when checked #then orchestrator=$expected",
  async ({ native, sqlite, agent, expected }) => {
    // given
    spyOn(storage, "isSqliteBackend").mockReturnValue(sqlite)
    const messages = mock(async () => ({
      data: [{ info: { agent, model: { providerID: "mock", modelID: "local" } } }],
    }))
    const client = unsafeTestValue<PluginInput["client"]>({ session: { messages } })
    if (native) storage.bindNativeSdkStorage(client)
    // when
    const actual = await isCallerOrchestrator("ses_caller", client)
    // then
    expect(actual).toBe(expected)
    expect(messages).toHaveBeenCalledTimes(1)
  },
)

it("#given an unbound V1 JSON caller #when checked #then local identity wins over the supplied SDK", async () => {
  // given
  const directory = mkdtempSync(join(tmpdir(), "atlas-v1-caller-"))
  directories.push(directory)
  writeFileSync(
    join(directory, "msg_local.json"),
    JSON.stringify({ agent: "atlas", model: { providerID: "mock", modelID: "local" } }),
  )
  spyOn(storage, "isSqliteBackend").mockReturnValue(false)
  spyOn(messageDirectory, "getMessageDir").mockReturnValue(directory)
  const messages = mock(async () => ({ data: [{ info: { agent: "sisyphus" } }] }))
  const client = unsafeTestValue<PluginInput["client"]>({ session: { messages } })
  // when
  const actual = await isCallerOrchestrator("ses_caller", client)
  // then
  expect(actual).toBe(true)
  expect(messages).not.toHaveBeenCalled()
})

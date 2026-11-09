import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as locks from "@oh-my-opencode/team-core/team-state-store/locks"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getJevRoutingStateDirectory, readJevRoutingHealth, warnJevRouting } from "./jev-routing-health"
import * as logger from "./logger"
import { routeCategoryWithJev } from "../tools/delegate-task/jev-category-routing"
import { categoryReply } from "../tools/delegate-task/jev-router.test-support"
import { JevRoutingConfigSchema } from "../config/schema/jev-routing"
import { checkModels } from "../cli/doctor/checks/model-resolution"
import * as config from "../cli/doctor/checks/model-resolution-config"
import * as ledger from "../tools/delegate-task/jev-routing-ledger"

let root: string
let fetchSpy: ReturnType<typeof spyOn>
let recordSpy: ReturnType<typeof spyOn>
const previous = process.env.XDG_DATA_HOME
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-health-"))
  process.env.XDG_DATA_HOME = root
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(categoryReply()))
  recordSpy = spyOn(ledger, "recordJevRouting")
})
afterEach(async () => {
  await Promise.all(recordSpy.mock.results.map((result) => (result.type === "return" ? result.value : undefined)))
  recordSpy.mockRestore()
  fetchSpy.mockRestore()
  if (previous === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previous
  rmSync(root, { recursive: true, force: true })
})
const routing = JevRoutingConfigSchema.parse({ mode: "active", default: "unspecified-low" })
const categories = { "unspecified-low": {}, "visual-engineering": {} }

function deadline<T>(promise: Promise<T>, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Routing proof stalled at ${stage}`)), 1000)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

test("model mismatch counters persist and appear in the existing doctor Models check", async () => {
  const configSpy = spyOn(config, "loadOmoConfig").mockReturnValue({})
  try {
    await warnJevRouting("model_mismatches")
    expect(await readJevRoutingHealth()).toMatchObject({ model_mismatches: 1 })
    const stored = JSON.parse(readFileSync(join(getJevRoutingStateDirectory(), "health.json"), "utf8"))
    expect(stored.model_mismatches).toBe(1)
    const result = await checkModels()
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        title: "Jev routing warnings",
        description: expect.stringContaining("1 pinned-model mismatches"),
      }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    configSpy.mockRestore()
  }
})

test("a ledger write failure warns and counts without changing the routing result", async () => {
  mkdirSync(join(root, "oh-my-opencode"), { recursive: true })
  writeFileSync(join(root, "oh-my-opencode", "jev-routing"), "blocked")
  const warning = Promise.withResolvers<void>()
  const logSpy = spyOn(logger, "log").mockImplementation((_message, data) => {
    if (typeof data === "object" && data !== null && "reason" in data && data.reason === "ledger_write_failures")
      warning.resolve()
  })
  try {
    expect(
      await routeCategoryWithJev({
        brief: "Implement change",
        config: routing,
        enabledCategories: categories,
        directory: root,
      }),
    ).toBe("visual-engineering")
    await warning.promise
    expect(await readJevRoutingHealth()).toMatchObject({ ledger_write_failures: 1 })
  } finally {
    logSpy.mockRestore()
  }
})

test("a pending ledger append does not delay active routing", async () => {
  const directory = getJevRoutingStateDirectory()
  mkdirSync(directory, { recursive: true })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const lockSpy = spyOn(locks, "withLock").mockImplementation(async () => {
    entered.resolve()
    await release.promise
  })
  try {
    const selected = routeCategoryWithJev({
      brief: "Implement change",
      config: routing,
      enabledCategories: categories,
      directory: root,
    })
    await deadline(entered.promise, "append entry")
    expect(await deadline(selected, "selection before append release")).toBe("visual-engineering")
    release.resolve()
    await release.promise
  } finally {
    release.resolve()
    lockSpy.mockRestore()
  }
})

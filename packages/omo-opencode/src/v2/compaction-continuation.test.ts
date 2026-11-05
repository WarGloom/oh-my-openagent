import { expect, it } from "bun:test"
import type { V2CompactionContinueEvent } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { registerCompactionContinuation, settleCompactionRestore } from "./compaction-continuation"

const continuation = (compactionID = "compact_1"): V2CompactionContinueEvent => ({
  sessionID: "ses_compact",
  compactionID,
  reason: "auto",
  enabled: true,
  agent: "Sisyphus",
  model: { providerID: "test", id: "model" },
})

it("awaits one restoration across duplicate native callbacks and the idle barrier", async () => {
  // given
  const fake = createFakePluginContext()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let restores = 0
  const registration = await registerCompactionContinuation(fake.context, async () => {
    restores += 1
    entered.resolve()
    await release.promise
  })
  try {
    // when
    const first = fake.triggerCompactionContinue(continuation())
    await entered.promise
    const duplicate = fake.triggerCompactionContinue(continuation())
    const idle = settleCompactionRestore("ses_compact")
    release.resolve()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate, idle])
    // then
    expect(firstResult.enabled).toBe(true)
    expect(duplicateResult.enabled).toBe(true)
    expect(restores).toBe(1)
  } finally {
    release.resolve()
    await registration.dispose()
  }
})

it("preserves a disabled continuation on replay and restores a later compaction independently", async () => {
  // given
  const fake = createFakePluginContext()
  const overflows: Array<boolean | undefined> = []
  const registration = await registerCompactionContinuation(fake.context, async (input, output) => {
    overflows.push(input.overflow)
    output.enabled = false
  })
  try {
    // when
    const first = await fake.triggerCompactionContinue({ ...continuation(), reason: "overflow" })
    const replay = await fake.triggerCompactionContinue(continuation())
    const later = await fake.triggerCompactionContinue(continuation("compact_2"))
    // then
    expect([first.enabled, replay.enabled, later.enabled]).toEqual([false, false, false])
    expect(overflows).toEqual([true, false])
  } finally {
    await registration.dispose()
  }
})

it("propagates restoration failure and permits a retry of that compaction", async () => {
  // given
  const fake = createFakePluginContext()
  const failure = new Error("Cannot restore compaction state")
  let attempts = 0
  const registration = await registerCompactionContinuation(fake.context, async () => {
    attempts += 1
    if (attempts === 1) throw failure
  })
  try {
    // when / then
    await expect(fake.triggerCompactionContinue(continuation())).rejects.toBe(failure)
    const retried = await fake.triggerCompactionContinue(continuation())
    expect(retried.enabled).toBe(true)
    expect(attempts).toBe(2)
  } finally {
    await registration.dispose()
  }
})

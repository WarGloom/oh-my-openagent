import { describe, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { PromptAsyncInput } from "@oh-my-opencode/utils/prompt-async-gate/types"
import { clearSessionModel, setSessionModel } from "../../shared/session-model-state"
import { createGoalHook } from "./index"

function makePluginInput(promptAsync: (input: PromptAsyncInput) => Promise<{ ok: boolean }> = mock(async () => ({ ok: true })), onStatus?: () => void): PluginInput {
  return {
    directory: mkdtempSync(join(tmpdir(), "goal-hook-")),
    client: {
      session: {
        status: async () => {
          onStatus?.()
          return { data: {} }
        },
        promptAsync,
        messages: {
          create: async () => ({ id: "msg-1" }),
        },
      },
    },
  } as unknown as PluginInput
}

describe("createGoalHook", () => {
  test("dispatches the latest accepted parent model, variant and agent after a switch", async () => {
    // given
    const sessionID = "goal-model-switch"
    const sent: PromptAsyncInput[] = []
    const ctx = makePluginInput(async (input) => { sent.push(input); return { ok: true } })
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal(sessionID, "Ship it")
    setSessionModel(sessionID, { providerID: "provider-a", modelID: "model-a", variant: "variant-a" }, "agent-a")
    setSessionModel(sessionID, { providerID: "provider-b", modelID: "model-b", variant: "variant-b" }, "agent-b")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({ model: { providerID: "provider-b", modelID: "model-b" }, variant: "variant-b", agent: "agent-b" })
    clearSessionModel(sessionID)
  })

  test("reads the switched parent model after idle settling, just before dispatch", async () => {
    // given
    const sessionID = "goal-model-during-settle"
    const sent: PromptAsyncInput[] = []
    setSessionModel(sessionID, { providerID: "provider-a", modelID: "model-a", variant: "variant-a" }, "agent-a")
    const ctx = makePluginInput(
      async (input) => { sent.push(input); return { ok: true } },
      () => setSessionModel(sessionID, { providerID: "provider-b", modelID: "model-b", variant: "variant-b" }, "agent-b"),
    )
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal(sessionID, "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({ model: { providerID: "provider-b", modelID: "model-b" }, variant: "variant-b", agent: "agent-b" })
    clearSessionModel(sessionID)
  })

  test("leaves goal dispatch without an explicit model when no parent selection exists", async () => {
    // given
    const sent: PromptAsyncInput[] = []
    const ctx = makePluginInput(async (input) => { sent.push(input); return { ok: true } })
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("goal-no-selection", "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "goal-no-selection" } } })

    // then
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).not.toHaveProperty("model")
  })

  test("setGoal and getGoal round trip", () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })

    const goal = hook.setGoal("s1", "Ship it")

    expect(goal.objective).toBe("Ship it")
    expect(hook.getGoal("s1")?.objective).toBe("Ship it")
  })

  test("clearGoal removes goal", () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("s1", "Ship it")

    hook.clearGoal("s1")

    expect(hook.getGoal("s1")).toBeNull()
  })

  test("session.deleted clears goal", async () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("s1", "Ship it")

    await hook.event({ event: { type: "session.deleted", properties: { sessionID: "s1" } } })

    expect(hook.getGoal("s1")).toBeNull()
  })

  test("session.idle injects continuation for active goal", async () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("s1", "Ship it")

    await hook.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    // No crash; injection is best-effort.
    expect(hook.getGoal("s1")?.status).toBe("active")
  })

  test("session.idle skips paused goal", async () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("s1", "Ship it")
    hook.pauseGoal("s1")

    await hook.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    expect(hook.getGoal("s1")?.status).toBe("paused")
  })

  test("event without sessionID is ignored", async () => {
    const ctx = makePluginInput()
    const hook = createGoalHook(ctx, { projectDir: ctx.directory })
    hook.setGoal("s1", "Ship it")

    await hook.event({ event: { type: "session.idle", properties: {} } })

    expect(hook.getGoal("s1")?.status).toBe("active")
  })

  test("does not dispatch an active goal while its session has monitor work", async () => {
    // given
    const promptAsync = mock(async () => ({ ok: true }))
    const ctx = makePluginInput(promptAsync)
    const hook = createGoalHook(ctx, { projectDir: ctx.directory, hasMonitorWork: (id) => id === "s1" })
    hook.setGoal("s1", "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    // then
    expect(promptAsync).not.toHaveBeenCalled()
    expect(hook.getGoal("s1")?.status).toBe("active")
  })

  test("rechecks monitor work at the prompt gate if it starts during idle settling", async () => {
    // given
    const promptAsync = mock(async () => ({ ok: true }))
    let monitorBusy = false
    const ctx = makePluginInput(promptAsync, () => { monitorBusy = true })
    const hook = createGoalHook(ctx, { projectDir: ctx.directory, hasMonitorWork: () => monitorBusy })
    hook.setGoal("s1", "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    // then
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("dispatches for an unrelated session", async () => {
    // given
    const promptAsync = mock(async () => ({ ok: true }))
    const ctx = makePluginInput(promptAsync)
    const hook = createGoalHook(ctx, { projectDir: ctx.directory, hasMonitorWork: (id) => id === "s1" })
    hook.setGoal("s2", "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } })
    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  test("dispatches normally when a session has no monitor work", async () => {
    // given
    const promptAsync = mock(async () => ({ ok: true }))
    const ctx = makePluginInput(promptAsync)
    const hook = createGoalHook(ctx, { projectDir: ctx.directory, hasMonitorWork: () => false })
    hook.setGoal("no-monitor", "Ship it")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "no-monitor" } } })

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  test("paused and completed goals do not dispatch regardless of monitor state", async () => {
    // given
    const promptAsync = mock(async () => ({ ok: true }))
    const ctx = makePluginInput(promptAsync)
    const hook = createGoalHook(ctx, { projectDir: ctx.directory, hasMonitorWork: () => false })
    hook.setGoal("paused", "Wait")
    hook.pauseGoal("paused")
    hook.setGoal("complete", "Done")
    hook.markComplete("complete")

    // when
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "paused" } } })
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "complete" } } })

    // then
    expect(promptAsync).not.toHaveBeenCalled()
  })
})

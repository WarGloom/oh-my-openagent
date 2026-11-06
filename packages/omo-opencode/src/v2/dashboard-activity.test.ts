import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, saveRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { createFakePluginContext } from "./fake-plugin-context"
import { registerNativeDashboard } from "./native-dashboard"

test("scoped native activity follows selected root and child agents and clears on idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-activity-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: join(directory, "teams") })
  const fake = createFakePluginContext({ directory })
  const selected = new Map([["lead", "Sisyphus"], ["child", "Explore"], ["member", "Atlas"], ["outside", "Hephaestus"]])
  const active = new Set(selected.keys())
  const lookedUp: string[] = []
  const context = { ...fake.context, session: { ...fake.context.session, get: async ({ sessionID }: { sessionID: string }) => {
    lookedUp.push(sessionID)
    const info = await fake.context.session.get({ sessionID })
    return { ...info, agent: selected.get(sessionID), time: { ...info.time, busy: 10, idle: active.has(sessionID) ? 0 : 11 } }
  } } }
  const team = await createRuntimeState(TeamSpecSchema.parse({ name: "visible", members: [{ name: "worker", kind: "subagent_type", subagent_type: "sisyphus" }] }), "lead", "project", config)
  await saveRuntimeState({ ...team, members: team.members.map((member) => ({ ...member, sessionId: "member", status: "running" })) }, config)
  const controller = new AbortController()
  const stream = fake.context.event.subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })[Symbol.asyncIterator]()
  const reset = stream.next()
  const dashboard = await registerNativeDashboard(context, { teamModeConfig: config, backgroundManager: {
    getTasksByParentSession: (id) => id === "lead" ? [{ id: "task", parentSessionId: "lead", parentMessageId: "msg", sessionId: "child", agent: "old-agent", description: "inspect", prompt: "private", status: "running" }] : [],
    onVisibleChange: () => () => {},
  } })
  try {
    await reset
    expect((await dashboard.get({ sessionID: "lead" }))?.activity).toEqual({ agents: [
      { name: "sisyphus", status: "busy" }, { name: "explore", status: "busy" }, { name: "atlas", status: "busy" },
    ], loop: null })
    expect((await dashboard.get({ sessionID: "member" }))?.activity.agents).toEqual([
      { name: "atlas", status: "busy" }, { name: "sisyphus", status: "busy" },
    ])
    expect(lookedUp).not.toContain("outside")
    const switched = stream.next()
    selected.set("lead", "Prometheus")
    fake.emit({ type: "session.agent.selected", data: { sessionID: "lead", agent: "Prometheus" } })
    await switched
    expect(await stream.next()).toMatchObject({ value: { data: { sessionIDs: ["lead", "member"] } } })
    expect((await dashboard.get({ sessionID: "lead" }))?.activity.agents[0]).toEqual({ name: "prometheus", status: "busy" })
    const childChanged = stream.next()
    selected.set("child", "Librarian")
    fake.emit({ type: "session.agent.selected", data: { sessionID: "child", agent: "Librarian" } })
    await childChanged
    expect(await stream.next()).toMatchObject({ value: { data: { sessionIDs: ["lead"] } } })
    expect((await dashboard.get({ sessionID: "lead" }))?.activity.agents[1]).toEqual({ name: "librarian", status: "busy" })
    const idle = stream.next()
    active.clear()
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: "lead" } })
    await idle
    expect(await stream.next()).toMatchObject({ value: { data: { sessionIDs: ["lead", "member"] } } })
    expect((await dashboard.get({ sessionID: "lead" }))?.activity.agents).toEqual([])
  } finally {
    await dashboard.dispose()
    controller.abort()
    await rm(directory, { recursive: true, force: true })
  }
})

test("completed tools and context owners refresh redacted location loop state without an execution event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-loop-"))
  const fake = createFakePluginContext({ directory })
  const loopDirectory = join(directory, ".omo", "ulw-loop", "current")
  const goal = { id: "private-id", title: "private goal title", status: "in_progress", successCriteria: [{ status: "pending" }] }
  const writer = await fake.context.tool.hook("execute.after", async () => {
    await mkdir(loopDirectory, { recursive: true })
    await writeFile(join(loopDirectory, "goals.json"), JSON.stringify({ version: 1, goals: [goal] }))
  })
  const contextWriter = await fake.context.session.hook("context", async () => {
    await writeFile(join(loopDirectory, "goals.json"), JSON.stringify({ version: 1, goals: [{ ...goal, successCriteria: [{ status: "pass" }] }] }))
  })
  const controller = new AbortController()
  const stream = fake.context.event.subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })[Symbol.asyncIterator]()
  const reset = stream.next()
  const dashboard = await registerNativeDashboard(fake.context)
  try {
    await reset
    expect((await dashboard.get({ sessionID: "lead" }))?.activity.loop).toBeNull()
    await dashboard.get({ sessionID: "second" })
    const changed = stream.next()
    await fake.triggerToolAfter({ tool: "edit", sessionID: "lead", agent: "sisyphus", messageID: "msg", id: "call", input: {}, status: "completed", result: {} })
    expect(await changed).toMatchObject({ value: { data: { sessionIDs: ["lead", "second"] } } })
    expect((await dashboard.get({ sessionID: "lead" }))?.activity).toEqual({ agents: [], loop: {
      kind: "live", goalsDone: 0, goalsTotal: 1, pass: 0, fail: 0, pending: 1, blocked: 0, activeGoal: null,
    } })
    const refreshed = stream.next()
    await fake.triggerContext({ sessionID: "lead", agent: "sisyphus", model: { providerID: "fake", id: "unused" }, system: [], messages: [], options: {} })
    await refreshed
    expect((await dashboard.get({ sessionID: "second" }))?.activity.loop).toEqual({
      kind: "live", goalsDone: 0, goalsTotal: 1, pass: 1, fail: 0, pending: 0, blocked: 0, activeGoal: null,
    })
    await dashboard.dispose()
    expect(fake.toolHookCount()).toBe(1)
    expect(fake.sessionHookCount()).toBe(1)
    const timer = spyOn(globalThis, "setTimeout")
    try {
      await fake.triggerToolAfter({ tool: "edit", sessionID: "lead", agent: "sisyphus", messageID: "msg", id: "call", input: {}, status: "completed", result: {} })
      expect(timer).toHaveBeenCalledTimes(0)
    } finally { timer.mockRestore() }
  } finally {
    await dashboard.dispose()
    await writer.dispose()
    await contextWriter.dispose()
    controller.abort()
    await rm(directory, { recursive: true, force: true })
  }
})

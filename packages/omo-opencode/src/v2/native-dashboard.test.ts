import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, saveRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { removeRuntimeDirectory } from "@oh-my-opencode/team-core/team-state-store/runtime-cleanup"
import { createTask } from "@oh-my-opencode/team-core/team-tasklist"
import { BackgroundManager } from "../features/background-agent"
import { MonitorManager } from "../features/monitor/manager"
import type { ExitResult } from "../features/monitor/process"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { registerNativeDashboard } from "./native-dashboard"
import { createSessionTracker } from "./session-tracker"

test("real task, monitor and team commits invalidate scoped snapshots; removed teams notify prior members", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dashboard-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: root })
  const fake = createFakePluginContext({ directory: root })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const background = new BackgroundManager({ pluginContext: input, enableParentSessionNotifications: false })
  const exit = Promise.withResolvers<ExitResult>()
  const monitor = new MonitorManager({ pluginContext: input, deps: {
    spawnMonitoredProcess: () => ({
      stdout: new ReadableStream({ start(controller) { controller.close() } }),
      stderr: new ReadableStream({ start(controller) { controller.close() } }),
      exited: exit.promise, kill: () => { exit.resolve({ code: 0, signal: null }) },
    }),
    createInjector: () => ({ queueBatch: () => {}, flushMonitor: async () => {} }),
    registerManagerForCleanup: () => {}, unregisterManagerForCleanup: () => {},
  } })
  const controller = new AbortController()
  const stream = fake.context.event.subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })[Symbol.asyncIterator]()
  const reset = stream.next()
  const dashboard = await registerNativeDashboard(fake.context, { backgroundManager: background, monitorManager: monitor, teamModeConfig: config })
  try {
    await reset
    await dashboard.get({ sessionID: "lead" })
    await dashboard.get({ sessionID: "member" })
    const first = stream.next()
    const task = await background.trackTask({ taskId: "task", sessionId: "child", parentSessionId: "lead", description: "inspect" })
    const watched = await monitor.start({ command: "controlled", label: "checks", parentSessionId: "lead" })
    const spec = TeamSpecSchema.parse({ name: "visible", members: [{ name: "worker", kind: "subagent_type", subagent_type: "sisyphus" }] })
    const team = await createRuntimeState(spec, "lead", "project", config)
    await saveRuntimeState({ ...team, members: team.members.map((member) => ({ ...member, sessionId: "member" })) }, config)
    await createTask(team.teamRunId, { subject: "work", description: "private", status: "pending", blocks: [], blockedBy: [] }, config)
    expect(await first).toMatchObject({ value: { type: "rpc.omo.dashboard.changed", data: { revision: 2, sessionIDs: ["lead", "member"] } } })
    const before = await dashboard.get({ sessionID: "lead" })
    expect(before?.tasks.counts.running).toBe(1)
    expect(before?.monitors.counts.running).toBe(1)
    expect(before?.teams[0]?.tasks.pending).toBe(1)
    const terminal = stream.next()
    task.status = "interrupt"
    exit.resolve({ code: 7, signal: null })
    expect(await terminal).toMatchObject({ value: { data: { revision: 3, sessionIDs: ["lead"] } } })
    const after = await dashboard.get({ sessionID: "lead" })
    expect(after?.tasks.counts.interrupt).toBe(1)
    expect(after?.monitors.rows).toEqual([{ id: watched.id, label: "checks", status: "exited", exitCode: 7 }])
    const removed = stream.next()
    await removeRuntimeDirectory(team.teamRunId, config)
    expect(await removed).toMatchObject({ value: { data: { revision: 4, sessionIDs: ["lead", "member"] } } })
    expect((await dashboard.get({ sessionID: "member" }))?.teams).toEqual([])
    const unrelated = await createRuntimeState({ ...spec, name: "unrelated" }, "outside", "project", config)
    await saveRuntimeState({ ...unrelated, status: "active" }, config)
  } finally {
    await dashboard.dispose()
    controller.abort()
    await monitor.shutdown()
    background.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

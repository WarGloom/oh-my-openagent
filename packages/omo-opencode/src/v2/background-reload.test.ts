import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import { createManagers, type Managers } from "../create-managers"
import { createRuntimeTmuxConfig } from "../create-runtime-tmux-config"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { createPluginDispose } from "../plugin-dispose"
import { createModelCacheState } from "../plugin-state"
import type { V2PromptInput, V2SessionMessage } from "./context-types"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"

afterEach(clearBackgroundTaskRegistryForTesting)

describe("V2 background task reload", () => {
  it("#given a running child #when the plugin unloads and reloads #then the same task survives and completion reaches its parent", async () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-reload-"))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(directory, "data")
    const fake = createFakePluginContext({ directory, sessionAgent: "Sisyphus" })
    const messages: V2SessionMessage[] = []
    const contextRead = spyOn(fake.context.session, "context").mockImplementation(async ({ sessionID }) => sessionID === "child" ? messages : [])
    const delivered = Promise.withResolvers<V2PromptInput>()
    const originalPrompt = fake.context.session.prompt
    const originalSynthetic = fake.context.session.synthetic
    const prompt = spyOn(fake.context.session, "prompt").mockImplementation(async (input) => {
      await originalPrompt(input)
      delivered.resolve(input)
    })
    const synthetic = spyOn(fake.context.session, "synthetic").mockImplementation(async (input) => {
      await originalSynthetic(input)
      delivered.resolve(input)
    })
    const generations: Managers[] = []
    const cleanupManagers: Array<{ shutdown: () => void | Promise<void> }> = []
    const config = OhMyOpenCodeConfigSchema.parse({ tui: { sidebar: { enabled: false } } })
    const setup = createV2Setup({ serverPlugin: async (input) => {
      const managers = createManagers({
        ctx: input,
        pluginConfig: config,
        tmuxConfig: createRuntimeTmuxConfig(config),
        modelCacheState: createModelCacheState(),
        backgroundNotificationHookEnabled: true,
        deps: { registerManagerForCleanupFn: (manager) => { cleanupManagers.push(manager) } },
      })
      generations.push(managers)
      return {
        event: async ({ event }) => { managers.backgroundManager.handleEvent(event) },
        dispose: createPluginDispose({ ...managers, disposeHooks: () => {} }),
      }
    } })
    let cleanup: (() => void | Promise<void>) | undefined
    try {
      cleanup = await setup(fake.context)
      const first = generations[0]
      if (!first) throw new Error("first generation missing")
      const task = await first.backgroundManager.trackTask({ taskId: "bg_reload", sessionId: "child", parentSessionId: "parent", agent: "Sisyphus", description: "reload task", parentAgent: "Sisyphus", concurrencyKey: "openai/gpt-6.1-sol" })
      task.startedAt = new Date(Date.now() - 10_000)
      task.model = { providerID: "openai", modelID: "gpt-6.1-sol", reasoning: "high" }
      fake.emit({ type: "session.execution.started", data: { sessionID: "child" } })

      // when
      await cleanup()
      cleanup = undefined
      expect(fake.sessionCalls.filter((call) => call.kind === "interrupt")).toEqual([])
      expect(first.backgroundManager.getTask("bg_reload")?.prompt).toBe("[redacted]")
      const foreignCleanup = await setup({ ...fake.context, location: { ...fake.context.location, directory: join(directory, "other-project") } })
      try {
        expect(generations[1]?.backgroundManager.getRunningTasks()).toEqual([])
      } finally {
        await foreignCleanup()
      }
      cleanup = await setup(fake.context)
      const second = generations[2]
      if (!second) throw new Error("second generation missing")
      expect(second.backgroundManager.findBySession("child")).toMatchObject({ id: "bg_reload", status: "running", parentSessionId: "parent", model: task.model })
      expect(second.backgroundManager.getTasksByParentSession("parent")).toHaveLength(1)
      messages.push({ type: "assistant", id: "answer", agent: "Sisyphus", model: { providerID: "openai", id: "gpt-6.1-sol" }, content: [{ type: "text", text: "finished after reload" }], finish: "stop", time: { created: Date.now() - 1000, completed: Date.now() } })
      await fake.triggerIdle({ sessionID: "child", background: [] })
      fake.emit({ type: "session.execution.succeeded", data: { sessionID: "child" } })
      const notification = await delivered.promise

      // then
      expect(notification.sessionID).toBe("parent")
      expect(notification.text).toContain("bg_reload")
      expect(second.backgroundManager.getTask("bg_reload")?.status).toBe("completed")
      expect(fake.sessionCalls.filter((call) => call.kind === "prompt" || call.kind === "synthetic")).toHaveLength(1)
    } finally {
      await cleanup?.()
      for (const manager of cleanupManagers) await manager.shutdown()
      contextRead.mockRestore()
      prompt.mockRestore()
      synthetic.mockRestore()
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("#given a child completes while its parent is busy #when the plugin reloads before the parent idles #then the parent gets the completion exactly once", async () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-reload-"))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(directory, "data")
    const fake = createFakePluginContext({ directory, sessionAgent: "Sisyphus" })
    const messages: V2SessionMessage[] = []
    const contextRead = spyOn(fake.context.session, "context").mockImplementation(async ({ sessionID }) => sessionID === "child" ? messages : [])
    const delivered = Promise.withResolvers<V2PromptInput>()
    const originalPrompt = fake.context.session.prompt
    const originalSynthetic = fake.context.session.synthetic
    const prompt = spyOn(fake.context.session, "prompt").mockImplementation(async (input) => {
      await originalPrompt(input)
      delivered.resolve(input)
    })
    const synthetic = spyOn(fake.context.session, "synthetic").mockImplementation(async (input) => {
      await originalSynthetic(input)
      delivered.resolve(input)
    })
    const generations: Managers[] = []
    const cleanupManagers: Array<{ shutdown: () => void | Promise<void> }> = []
    const config = OhMyOpenCodeConfigSchema.parse({ tui: { sidebar: { enabled: false } } })
    const setup = createV2Setup({ serverPlugin: async (input) => {
      const managers = createManagers({
        ctx: input,
        pluginConfig: config,
        tmuxConfig: createRuntimeTmuxConfig(config),
        modelCacheState: createModelCacheState(),
        backgroundNotificationHookEnabled: true,
        deps: { registerManagerForCleanupFn: (manager) => { cleanupManagers.push(manager) } },
      })
      generations.push(managers)
      return {
        event: async ({ event }) => { managers.backgroundManager.handleEvent(event) },
        dispose: createPluginDispose({ ...managers, disposeHooks: () => {} }),
      }
    } })
    let cleanup: (() => void | Promise<void>) | undefined
    try {
      cleanup = await setup(fake.context)
      const first = generations[0]
      if (!first) throw new Error("first generation missing")
      const task = await first.backgroundManager.trackTask({ taskId: "bg_queued", sessionId: "child", parentSessionId: "parent", agent: "Sisyphus", description: "queued task", parentAgent: "Sisyphus", concurrencyKey: "openai/gpt-6.1-sol" })
      task.startedAt = new Date(Date.now() - 10_000)
      fake.emit({ type: "session.execution.started", data: { sessionID: "parent" } })
      fake.emit({ type: "session.execution.started", data: { sessionID: "child" } })
      messages.push({ type: "assistant", id: "answer", agent: "Sisyphus", model: { providerID: "openai", id: "gpt-6.1-sol" }, content: [{ type: "text", text: "finished before reload" }], finish: "stop", time: { created: Date.now() - 1000, completed: Date.now() } })
      await fake.triggerIdle({ sessionID: "child", background: [] })
      fake.emit({ type: "session.execution.succeeded", data: { sessionID: "child" } })
      await delivered.promise

      // when
      await cleanup()
      cleanup = undefined
      cleanup = await setup(fake.context)
      const second = generations[1]
      if (!second) throw new Error("second generation missing")
      await fake.triggerIdle({ sessionID: "parent", background: [] })
      fake.emit({ type: "session.execution.succeeded", data: { sessionID: "parent" } })
      const notification = await delivered.promise

      // then
      expect(notification.sessionID).toBe("parent")
      expect(notification.text).toContain("bg_queued")
      expect(fake.sessionCalls.filter((call) => call.kind === "prompt" || call.kind === "synthetic")).toHaveLength(1)
    } finally {
      await cleanup?.()
      for (const manager of cleanupManagers) await manager.shutdown()
      contextRead.mockRestore()
      prompt.mockRestore()
      synthetic.mockRestore()
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it, spyOn } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import * as validation from "../config/validate"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import * as roster from "../features/tui-sidebar/roster-resolver"
import type { DashboardSnapshot } from "./dashboard-channel"
import tuiModule from "../tui"
import { setupV2Tui } from "./tui-setup"

function fixture(enabled = true) {
  const preference = { enabled }
  const config = spyOn(validation, "validatePluginConfig").mockImplementation(async () => ({
    valid: true, messages: [], warnings: [], path: null, config: OhMyOpenCodeConfigSchema.parse({ tui: { sidebar: { enabled: preference.enabled } } }),
  }))
  const resolveRoster = spyOn(roster, "resolveRoster").mockResolvedValue([])
  const [route, setRoute] = createSignal<ReturnType<Plugin.Context["ui"]["router"]["current"]>>({ type: "session", sessionID: "lead" })
  const slots: Parameters<Plugin.Context["ui"]["slot"]>[0][] = []
  const pages: Parameters<Plugin.Context["ui"]["router"]["register"]>[0][] = []
  const layers: ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>[] = []
  type Event = { readonly location?: { readonly directory: string }; readonly data: unknown }
  const handlers = new Map<string, Set<(event: Event) => void>>()
  const on = (name: string, callback: (event: Event) => void) => {
    const set = handlers.get(name) ?? new Set()
    set.add(callback); handlers.set(name, set)
    return () => { set.delete(callback) }
  }
  const remove = <T,>(values: T[], value: T) => { values.splice(values.indexOf(value), 1) }
  const color = "#eeeeee"
  const action = { base: color, hovered: color, focused: color, pressed: color }
  const calls: string[] = []
  const snapshot: DashboardSnapshot = {
    revision: 1, sessionID: "lead", activity: { agents: [{ name: "native-agent", status: "busy" }],
      loop: { kind: "live", goalsDone: 1, goalsTotal: 3, pass: 2, fail: 1, pending: 1, blocked: 0, activeGoal: null } },
    tasks: { counts: { pending: 0, running: 1, completed: 0, error: 0, cancelled: 0, interrupt: 1 }, rows: [
      { id: "task", agent: "worker", description: "Child task", status: "running", sessionId: "child" },
    ] },
    monitors: { counts: { starting: 0, running: 0, exited: 0, stopped: 0, failed: 1 }, rows: [
      { id: "monitor", label: "Failed compile", status: "failed", exitCode: 7 },
    ] },
    teams: [{ teamRunId: "run", teamName: "Native team", status: "active", members: [{ name: "Native member", status: "idle", sessionId: "member" }],
      tasks: { pending: 0, claimed: 0, in_progress: 1, completed: 2, deleted: 0 } }],
  }
  const context = {
    location: { directory: "/setup" }, theme: { text: { base: color, muted: color, feedback: {
      error: { base: color }, warning: { base: color }, success: { base: color }, info: { base: color },
    }, action: { primary: action, secondary: action } }, background: { base: "#202020", action: {
      primary: { ...action, base: "#333333" }, secondary: { ...action, base: "#202020" },
    } } },
    client: { rpc: () => ({ events: { on }, get: async ({ sessionID }: { readonly sessionID: string }) => {
      calls.push(sessionID); return { ...snapshot, sessionID }
    } }) },
    data: { on, session: { get: () => ({ location: { directory: "/actual-session" } }) } },
    keymap: { layer: (factory: Parameters<Plugin.Context["keymap"]["layer"]>[0]) => {
      const layer = factory(); layers.push(layer); onCleanup(() => remove(layers, layer))
    } },
    ui: { slot: (claim: Parameters<Plugin.Context["ui"]["slot"]>[0]) => { slots.push(claim); return () => remove(slots, claim) },
      router: { current: route, navigate: (destination: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]) => {
        setRoute(destination.type === "plugin" ? { ...destination, id: "omo" } : destination)
      }, register: (page: Parameters<Plugin.Context["ui"]["router"]["register"]>[0]) => { pages.push(page); return () => remove(pages, page) } },
      dialog: { clear: () => {} }, toast: { show: () => {} } },
  }
  const emit = (name: string, global = false) => { for (const callback of handlers.get(name) ?? []) callback({
    ...(global ? {} : { location: { directory: "/actual-session" } }), data: { revision: 2, sessionIDs: ["lead"] },
  }) }
  const render = () => {
    for (const slot of slots) if (slot.append === "app") slot.render({})
    const sidebar = slots.find((slot) => slot.append === "sidebar.content")
    return sidebar?.append === "sidebar.content" ? sidebar.render({ sessionID: "lead" }) : null
  }
  return { context, slots, pages, layers, handlers, calls, snapshot, route, render, emit, preference,
    restore: () => { config.mockRestore(); resolveRoster.mockRestore() } }
}

describe("OpenCode 2.x native dashboard setup", () => {
  it("preserves both TUI loader entrypoints", () => {
    expect(typeof tuiModule.tui).toBe("function")
    expect(tuiModule.setup).toBe(setupV2Tui)
  })

  it("registers a real palette page, renders scoped activity and updates the sidebar without polling", async () => {
    const f = fixture()
    const cleanup: () => void = await Reflect.apply(setupV2Tui, undefined, [f.context])
    const app = await testRender(f.render, { width: 80, height: 50 })
    try {
      const frame = await app.waitForFrame((text) => text.includes("native-agent") && text.includes("goals 1/3"))
      expect(frame).toContain("1 interrupted")
      expect(frame).toContain("1 failed")
      expect(frame).toContain("active private")
      f.snapshot.tasks.counts.running = 2
      f.snapshot.tasks.rows[0].description = "Updated child"
      f.emit("changed")
      await app.waitForFrame((text) => text.includes("2 running") && text.includes("Updated child"))
      const command = f.layers.flatMap((layer) => layer.commands ?? []).find((item) => item.id === "omo.dashboard.open")
      if (!command) throw new Error("Dashboard command missing")
      command.run()
      expect(f.route()).toMatchObject({ type: "plugin", name: "omo-dashboard" })
      const page = f.pages[0]
      if (!page) throw new Error("Dashboard page missing")
      const full = await testRender(() => page.render({}), { width: 32, height: 20 })
      try {
        await full.renderOnce()
        expect(full.captureCharFrame()).toContain("Dashboard")
        expect(full.captureCharFrame()).not.toContain("Native member")
        full.mockInput.pressKey("\x1b[6~")
        await full.waitForFrame((text) => text.includes("Failed compile") && !text.includes("Dashboard"))
        full.mockInput.pressKey("\x1b[F")
        await full.waitForFrame((text) => text.includes("Native member"))
        const back = f.layers.flatMap((layer) => layer.commands ?? []).find((item) => item.bind === "escape")
        back?.run()
        expect(f.route()).toEqual({ type: "session", sessionID: "lead" })
      } finally { full.renderer.destroy() }
      f.preference.enabled = false
      f.emit("config.updated", true)
      await app.waitForFrame((text) => text.trim() === "")
    } finally {
      app.renderer.destroy(); cleanup(); f.restore()
    }
    expect(f.slots).toHaveLength(0)
    expect(f.pages).toHaveLength(0)
    expect(f.layers).toHaveLength(0)
    expect([...f.handlers.values()].reduce((sum, set) => sum + set.size, 0)).toBe(0)
  })

  it("keeps the palette and toast subscription available with the sidebar disabled", async () => {
    const f = fixture(false)
    const cleanup: () => void = await Reflect.apply(setupV2Tui, undefined, [f.context])
    const app = await testRender(f.render, { width: 80, height: 20 })
    try {
      await app.renderOnce()
      expect(app.captureCharFrame().trim()).toBe("")
      expect(f.handlers.get("rpc.omo.toast")?.size).toBe(1)
      const command = f.layers.flatMap((layer) => layer.commands ?? []).find((item) => item.id === "omo.dashboard.open")
      command?.run()
      expect(f.route()).toMatchObject({ type: "plugin", name: "omo-dashboard" })
      expect(f.calls).toEqual(["lead", "lead"])
    } finally { app.renderer.destroy(); cleanup(); f.restore() }
  })
})

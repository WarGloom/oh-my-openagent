import type { Plugin } from "@opencode/plugin/tui"
import type { BaseRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { validatePluginConfig } from "../config/validate"
import { computeView } from "../features/tui-sidebar/compute-view"
import { deriveConfig, deriveRoster } from "../features/tui-sidebar/derivers"
import { buildViewNodes } from "../features/tui-sidebar/render-view"
import { resolveRoster } from "../features/tui-sidebar/roster-resolver"
import type { RosterState } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import { materializeReactive } from "../tui"
import { createDashboardClient, type NativeDashboardState } from "./dashboard-client"
import { buildDashboardFullViewNodes } from "./dashboard-full-view"
import { buildDashboardActivityNodes, buildDashboardSidebarNodes, dashboardAction } from "./dashboard-view"
import { toastSchema } from "./toast-channel"

export type V2TuiSetup = Plugin.Definition["setup"]

declare module "@opentui/solid" {
  function createElement(tag: "scrollbox"): ScrollBoxRenderable
  function createElement(tag: string): BaseRenderable
}

export const setupV2Tui: V2TuiSetup = async (ctx) => {
  log("[tui] OpenCode 2.x TUI detected; BTW is not ported to the 2.x TUI API yet")
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory
  const initial = await validatePluginConfig(directory)
  const [solid, reactive] = await Promise.all([import("@opentui/solid"), import("solid-js")])
  return reactive.createRoot((disposeRoot) => {
    const [state, setState] = reactive.createSignal<NativeDashboardState | null>(null)
    const [local, setLocal] = reactive.createSignal<{
      readonly validation: typeof initial
      readonly roster: RosterState
    }>({ validation: initial, roster: { kind: "empty" } })
    const client = createDashboardClient(ctx, setState)
    let previous = { ...ctx.ui.router.current() }
    let configTurn = 0
    let configDirectory = directory
    let configSession: string | undefined
    let disposed = false
    const refreshConfig = async (): Promise<void> => {
      const turn = ++configTurn
      const path = configDirectory
      const validation = await validatePluginConfig(path)
      const roster = deriveRoster(await resolveRoster(path, validation.config))
      if (!disposed && turn === configTurn) setLocal({ validation, roster })
    }
    const navigate = (sessionID: string): void => ctx.ui.router.navigate({ type: "session", sessionID })
    const open = (): void => {
      const current = ctx.ui.router.current()
      if (current.type === "plugin" && current.name === "omo-dashboard") return
      previous = { ...current }
      ctx.ui.dialog.clear()
      ctx.ui.router.navigate({ type: "plugin", name: "omo-dashboard" })
      void client.refresh()
    }
    const close = (): void => ctx.ui.router.navigate(previous)
    const offToast = ctx.data.on("rpc.omo.toast", (event) => {
      const toast = toastSchema.safeParse(event.data)
      if (toast.success) ctx.ui.toast.show(toast.data)
    })
    const offConfig = ctx.data.on("config.updated", (event) => {
      if (event.location === undefined || event.location.directory === configDirectory) void refreshConfig()
    })
    const offConnected = ctx.data.on("server.connected", () => {
      void refreshConfig()
    })
    const offPage = ctx.ui.router.register({
      name: "omo-dashboard",
      render: () => {
        const shell = solid.createElement("box")
        solid.setProp(shell, "width", "100%")
        solid.setProp(shell, "height", "100%")
        solid.setProp(shell, "flexDirection", "column")
        solid.setProp(shell, "backgroundColor", ctx.theme.background.base)
        const scroll = solid.createElement("scrollbox")
        solid.setProp(scroll, "flexGrow", 1)
        solid.setProp(scroll, "minHeight", 0)
        solid.setProp(scroll, "scrollX", false)
        solid.setProp(scroll, "contentOptions", { padding: 1, flexShrink: 0 })
        const focusables = (node: Renderable): Renderable[] =>
          node.getChildren().flatMap((child) => (child.focusable ? [child] : focusables(child)))
        const moveFocus = (direction: number): void => {
          const actions = [scroll, ...focusables(scroll)]
          const current = actions.findIndex((node) => node.focused)
          const next = actions[(current + direction + actions.length) % actions.length]
          next?.focus()
          if (next && next !== scroll) scroll.scrollChildIntoView(next.id)
        }
        ctx.keymap.layer(() => ({
          commands: [
            { bind: "escape", title: "Back", run: close },
            { bind: "tab", title: "Next action", run: () => moveFocus(1) },
            { bind: "shift+tab", title: "Previous action", run: () => moveFocus(-1) },
          ],
        }))
        reactive.onMount(() => scroll.focus())
        solid.insert(
          shell,
          materializeReactive(() => [dashboardAction({ label: "Back (Esc)", run: close }, ctx.theme)], solid),
        )
        solid.insert(
          scroll,
          materializeReactive(
            () => buildDashboardFullViewNodes(state(), ctx.theme, { onNavigateSession: navigate }),
            solid,
          ),
        )
        solid.insert(shell, scroll)
        return shell
      },
    })
    const offApp = ctx.ui.slot({
      append: "app",
      render: () => {
        reactive.createComputed(() => {
          const route = ctx.ui.router.current()
          if (route.type === "plugin" && route.name === "omo-dashboard") return
          const id = route.type === "session" ? route.sessionID : undefined
          const path = id ? ctx.data.session.get(id)?.location.directory : directory
          void client.select(id)
          if (path && (path !== configDirectory || id !== configSession)) {
            configDirectory = path
            configSession = id
            void refreshConfig()
          }
        })
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "omo.dashboard.open",
              title: "Open OMO dashboard",
              group: "OMO",
              palette: true,
              slash: { name: "omo-dashboard" },
              run: open,
            },
          ],
        }))
        return null
      },
    })
    const offSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: () =>
        materializeReactive(() => {
          const config = local()
          if (config.validation.config.tui?.sidebar?.enabled === false) return []
          const current = state()
          return [
            ...buildViewNodes(
              computeView({
                config: deriveConfig(config.validation),
                roster: config.roster,
                agents: { kind: "none" },
                jobs: { kind: "none" },
                teams: { kind: "none" },
                loop: { kind: "none" },
              }),
              { text: ctx.theme.text.base, textMuted: ctx.theme.text.muted, error: ctx.theme.text.feedback.error.base },
            ),
            ...buildDashboardSidebarNodes(current, ctx.theme, { onOpenFullView: open, onNavigateSession: navigate }),
            ...(current?.kind === "ready" ? buildDashboardActivityNodes(current.snapshot.activity, ctx.theme) : []),
          ]
        }, solid),
    })
    reactive.onCleanup(() => {
      disposed = true
      configTurn++
      client.dispose()
      offToast()
      offConfig()
      offConnected()
      offSidebar()
      offApp()
      offPage()
      const current = ctx.ui.router.current()
      if (current.type === "plugin" && current.name === "omo-dashboard") close()
    })
    void refreshConfig()
    return disposeRoot
  })
}

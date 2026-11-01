import type { Plugin } from "@opencode/plugin/tui"
import { validatePluginConfig } from "../config/validate"
import { viewKey } from "../features/tui-sidebar/compute-view"
import { POLL_INTERVAL_MS } from "../features/tui-sidebar/constants"
import { buildViewNodes } from "../features/tui-sidebar/render-view"
import { TeamSessionCache } from "../features/tui-sidebar/team-session-cache"
import type { SidebarView } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import { handleTuiPollError, materializeReactive, readView } from "../tui"

export type V2TuiSetup = Plugin.Definition["setup"]

export const setupV2Tui: V2TuiSetup = async (ctx) => {
  log("[tui] OpenCode 2.x TUI detected; BTW is not ported to the 2.x TUI API yet")
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory
  if ((await validatePluginConfig(directory)).config.tui?.sidebar?.enabled === false) return

  const [solid, { createComputed, createSignal }] = await Promise.all([import("@opentui/solid"), import("solid-js")])
  const cache = new TeamSessionCache()
  const [view, setView] = createSignal<SidebarView>({ kind: "idle", roster: { kind: "empty" } })
  const [collapsed, setCollapsed] = createSignal(false)
  let key = viewKey(view())
  let sessionID: string | undefined
  let disposed = false
  let inFlight = false

  const refresh = async (): Promise<void> => {
    if (disposed || inFlight || !sessionID) return
    const currentSession = sessionID
    inFlight = true
    try {
      const sessionDirectory = ctx.data.session.get(currentSession)?.location.directory ?? directory
      const next = await readView(sessionDirectory, currentSession, cache)
      if (disposed || currentSession !== sessionID) return
      const nextKey = viewKey(next)
      if (key !== nextKey) {
        key = nextKey
        setView(next)
      }
    } catch (error) {
      handleTuiPollError(error)
    } finally {
      inFlight = false
    }
  }

  const unregister = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      createComputed(() => {
        sessionID = input.sessionID
        void refresh()
      })
      return materializeReactive(
        () =>
          buildViewNodes(
            view(),
            {
              text: ctx.theme.text.base,
              textMuted: ctx.theme.text.muted,
              error: ctx.theme.text.feedback.error.base,
              warning: ctx.theme.text.feedback.warning.base,
              success: ctx.theme.text.feedback.success.base,
              info: ctx.theme.text.feedback.info.base,
              accent: ctx.theme.text.base,
              borderSubtle: ctx.theme.border.base,
            },
            {
              collapsed: collapsed(),
              onToggle: () => setCollapsed((value) => !value),
              onNavigateSession: (id) => ctx.ui.router.navigate({ type: "session", sessionID: id }),
            },
          ),
        solid,
      )
    },
  })
  const offIdle = ctx.data.on("session.idle", () => {
    void refresh()
  })
  const offError = ctx.data.on("session.execution.failed", () => {
    void refresh()
  })
  const timer = setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
  return () => {
    disposed = true
    clearInterval(timer)
    offIdle()
    offError()
    unregister()
  }
}

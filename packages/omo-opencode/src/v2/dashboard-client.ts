import type { Plugin } from "@opencode/plugin/tui"
import { dashboardChannel, type DashboardSnapshot } from "./dashboard-channel"
import type { DashboardViewState } from "./dashboard-view"

export type NativeDashboardState =
  | Exclude<DashboardViewState, { readonly kind: "ready" }>
  | { readonly kind: "ready"; readonly snapshot: DashboardSnapshot }

export function createDashboardClient(
  context: Pick<Plugin.Context, "client" | "data">,
  publish: (state: NativeDashboardState | null) => void,
) {
  const rpc = context.client.rpc(dashboardChannel)
  const lifetime = new AbortController()
  let sessionID: string | undefined
  let directory: string | undefined
  let generation = 0
  let disposed = false
  const refresh = async (): Promise<void> => {
    const turn = ++generation
    const id = sessionID
    const location = id ? context.data.session.get(id)?.location : undefined
    if (disposed) return
    if (!id || !location) {
      publish(null)
      return
    }
    try {
      const snapshot = await rpc.get({ sessionID: id }, { location, signal: lifetime.signal })
      if (disposed || turn !== generation || sessionID !== id) return
      if (context.data.session.get(id)?.location.directory !== location.directory) return
      publish(snapshot === null || snapshot.sessionID !== id ? null : { kind: "ready", snapshot })
    } catch {
      if (!disposed && turn === generation) publish({ kind: "error", message: "Connection failed" })
    }
  }
  const offChanged = rpc.events.on("changed", (event) => {
    if (disposed || !sessionID) return
    const location = context.data.session.get(sessionID)?.location
    if (!location || event.location.directory !== location.directory) return
    if (event.data.sessionIDs !== undefined && !event.data.sessionIDs.includes(sessionID)) return
    void refresh()
  })
  const offConnected = context.data.on("server.connected", () => {
    void refresh()
  })
  const offDeleted = context.data.on("session.deleted", (event) => {
    if (event.data.sessionID !== sessionID) return
    generation++
    sessionID = undefined
    directory = undefined
    publish(null)
  })
  const actionOptions = (id: string) => {
    const location = context.data.session.get(id)?.location
    if (disposed || id !== sessionID || !location || location.directory !== directory)
      throw new Error("Dashboard session changed; reopen the dashboard")
    return { location, signal: lifetime.signal }
  }
  return {
    refresh,
    cancelTask: (input: { readonly sessionID: string; readonly taskID: string }) =>
      rpc.cancelTask(input, actionOptions(input.sessionID)),
    retryTask: (input: { readonly sessionID: string; readonly taskID: string }) =>
      rpc.retryTask(input, actionOptions(input.sessionID)),
    stopMonitor: (input: { readonly sessionID: string; readonly monitorID: string }) =>
      rpc.stopMonitor(input, actionOptions(input.sessionID)),
    select: (id: string | undefined): Promise<void> => {
      const nextDirectory = id ? context.data.session.get(id)?.location.directory : undefined
      if (disposed || (id === sessionID && nextDirectory === directory)) return Promise.resolve()
      sessionID = id
      directory = nextDirectory
      publish(id && directory ? { kind: "loading" } : null)
      return refresh()
    },
    dispose: (): void => {
      disposed = true
      generation++
      lifetime.abort()
      offChanged()
      offConnected()
      offDeleted()
    },
  }
}

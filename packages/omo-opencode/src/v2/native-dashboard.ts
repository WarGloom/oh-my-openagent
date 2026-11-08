import { z } from "zod"
import { subscribeTeamRuntimeChanges } from "@oh-my-opencode/team-core/team-state-store"
import { WRITE_DEBOUNCE_MS } from "../features/tui-sidebar/constants"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration, V2SessionInfo } from "./context-types"
import { dashboardChannel, type DashboardSnapshot } from "./dashboard-channel"
import {
  dashboardTeamSessions,
  loadDashboardTeam,
  projectDashboard,
  type DashboardOwners,
} from "./dashboard-projection"
import { projectDashboardActivity } from "./dashboard-activity"
import { createDashboardActions, DashboardRetryUnavailableError } from "./native-dashboard-actions"

const sessionEvent = z.object({ sessionID: z.string() })
const activityEvents = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.agent.selected",
  "session.moved",
  "session.metadata.updated",
])

export async function registerNativeDashboard(context: V2PluginContext, owners?: DashboardOwners) {
  const interest = new Set<string>()
  const deleted = new Set<string>()
  const priorTeams = new Map<string, readonly string[]>()
  const dirtySessions = new Set<string>()
  const dirtyTeams = new Set<string>()
  const controller = new AbortController()
  const nativeHooks: V2Registration[] = []
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined

  const authorized = async (sessionID: string): Promise<V2SessionInfo | null> => {
    if (disposed || deleted.has(sessionID)) return null
    try {
      const info = await context.session.get({ sessionID })
      return !disposed && !deleted.has(sessionID) && info.location.directory === context.location.directory
        ? info
        : null
    } catch (error) {
      if (error instanceof Error) return null
      throw error
    }
  }
  const get = async ({ sessionID }: { readonly sessionID: string }): Promise<DashboardSnapshot | null> => {
    if (!(await authorized(sessionID))) {
      interest.delete(sessionID)
      return null
    }
    interest.add(sessionID)
    const observedRevision = revision
    const teamSessions = new Set<string>()
    const snapshot = await projectDashboard(sessionID, owners, (runID, ids) => {
      for (const id of ids) teamSessions.add(id)
      if (!disposed) priorTeams.set(runID, [...new Set([...(priorTeams.get(runID) ?? []), ...ids])])
    })
    const current = await authorized(sessionID)
    if (current === null) {
      interest.delete(sessionID)
      return null
    }
    const activity = await projectDashboardActivity(context, current, [
      ...snapshot.tasks.rows.flatMap((task) => (task.sessionId === undefined ? [] : [task.sessionId])),
      ...teamSessions,
    ])
    if (disposed || !interest.has(sessionID)) return null
    return { revision: observedRevision, sessionID, ...snapshot, activity }
  }
  const actions = createDashboardActions(owners, authorized)
  const registration = await context.rpc.register(dashboardChannel, {
    get,
    ...actions,
    retryTask: async (input, call) => {
      try {
        return await actions.retryTask(input)
      } catch (error) {
        if (error instanceof DashboardRetryUnavailableError) return call.error("unavailable", error.message)
        throw error
      }
    },
  })
  const flush = async (): Promise<void> => {
    const sessions = new Set(dirtySessions)
    const runs = [...dirtyTeams]
    dirtySessions.clear()
    dirtyTeams.clear()
    const config = owners?.teamModeConfig
    if (config?.enabled) {
      for (const runID of runs) {
        for (const id of priorTeams.get(runID) ?? []) sessions.add(id)
        const state = await loadDashboardTeam(runID, config)
        if (disposed) return
        if (state === null) priorTeams.delete(runID)
        else {
          const ids = dashboardTeamSessions(state)
          for (const id of ids) sessions.add(id)
          if (ids.some((id) => interest.has(id))) priorTeams.set(runID, ids)
          else priorTeams.delete(runID)
        }
      }
    }
    const visible: string[] = []
    for (const id of sessions) {
      if (!interest.has(id)) continue
      if (await authorized(id)) visible.push(id)
      else interest.delete(id)
    }
    const current = visible.filter((id) => interest.has(id))
    if (disposed || current.length === 0) return
    await registration.events.emit("changed", { revision: ++revision, sessionIDs: current.sort() })
  }
  const schedule = (): void => {
    if (disposed || flushing !== undefined || (dirtySessions.size === 0 && dirtyTeams.size === 0)) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      flushing = flush()
        .catch((error: unknown) => {
          if (!(error instanceof Error)) throw error
          log("[v2] dashboard change delivery failed", { error })
        })
        .finally(() => {
          flushing = undefined
          schedule()
        })
    }, WRITE_DEBOUNCE_MS)
  }
  const dirty = (sessionID: string): void => {
    if (disposed || !interest.has(sessionID)) return
    dirtySessions.add(sessionID)
    schedule()
  }
  const dirtyAffected = (sessionID: string): void => {
    dirty(sessionID)
    for (const id of interest) {
      if (owners?.backgroundManager.getTasksByParentSession(id).some((task) => task.sessionId === sessionID)) dirty(id)
    }
    for (const ids of priorTeams.values()) if (ids.includes(sessionID)) for (const id of ids) dirty(id)
  }
  const dirtyLocation = async (sessionID: string): Promise<void> => {
    if (interest.size === 0 || !(await authorized(sessionID))) return
    for (const id of interest) dirty(id)
  }
  const offBackground = owners?.backgroundManager.onVisibleChange(dirty)
  const offMonitor = owners?.monitorManager?.onVisibleChange(dirty)
  const offTeam = owners?.teamModeConfig?.enabled
    ? subscribeTeamRuntimeChanges((runID) => {
        if (disposed || interest.size === 0) return
        dirtyTeams.add(runID)
        schedule()
      })
    : undefined
  const events = (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      if (disposed) break
      if (!event.type.startsWith("session.")) continue
      const data = sessionEvent.safeParse(event.data)
      if (!data.success) continue
      const id = data.data.sessionID
      if (event.type === "session.deleted") {
        deleted.add(id)
        interest.delete(id)
        dirtySessions.delete(id)
        dirtyAffected(id)
      } else if (activityEvents.has(event.type)) dirtyAffected(id)
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return
    if (!(error instanceof Error)) throw error
    log("[v2] dashboard event stream failed", { error })
  })
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    offBackground?.()
    offMonitor?.()
    offTeam?.()
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    interest.clear()
    deleted.clear()
    dirtySessions.clear()
    dirtyTeams.clear()
    priorTeams.clear()
    for (const hook of nativeHooks.reverse()) await hook.dispose()
    await events
    await flushing
    await registration.dispose()
  }
  try {
    nativeHooks.push(await context.tool.hook("execute.after", (event) => dirtyLocation(event.sessionID)))
    nativeHooks.push(await context.session.hook("context", (event) => dirtyLocation(event.sessionID)))
    await registration.events.emit("changed", { revision: ++revision })
  } catch (error) {
    await dispose()
    throw error
  }
  return { get, ...actions, dispose }
}

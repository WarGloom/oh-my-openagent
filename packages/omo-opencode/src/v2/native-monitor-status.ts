import type { MonitorStatusInjectorHook } from "../hooks/monitor-status-injector/hook"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration } from "./context-types"
import { toV1ToolName } from "./tool-names"

const MONITOR_STATUS_KEY = "omo.monitor-status"
const MONITOR_STATUS_POLL_MS = 1_000

export async function registerNativeMonitorStatus(
  context: V2PluginContext,
  hook: MonitorStatusInjectorHook,
): Promise<V2Registration> {
  const installed = new Map<string, string>()
  const seen = new Set<string>()
  let disposed = false
  let queue = Promise.resolve()
  const refresh = (sessionID: string): Promise<void> => {
    const next = queue.then(async () => {
      if (disposed) return
      const value = hook.nativeStatusForSession(sessionID)
      if (value === undefined) {
        if (installed.has(sessionID) || !seen.has(sessionID)) {
          await context.session.instructions.entry.remove({ sessionID, key: MONITOR_STATUS_KEY })
        }
        installed.delete(sessionID)
      } else if (installed.get(sessionID) !== value) {
        await context.session.instructions.entry.put({ sessionID, key: MONITOR_STATUS_KEY, value })
        installed.set(sessionID, value)
      }
      seen.add(sessionID)
    })
    queue = next.catch((error: unknown) => {
      log("[v2] failed to refresh monitor status", { sessionID, error })
    })
    return queue
  }
  const request = await context.session.hook("context", async (event) => {
    await refresh(event.sessionID)
  })
  const tool = await context.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed") return
    const name = toV1ToolName(event.tool)
    if (name === "monitor_start" || name === "monitor_stop") await refresh(event.sessionID)
  })
  const timer = setInterval(() => {
    for (const sessionID of installed.keys()) void refresh(sessionID)
  }, MONITOR_STATUS_POLL_MS)
  return {
    dispose: async () => {
      disposed = true
      clearInterval(timer)
      await tool.dispose()
      await request.dispose()
      await queue
      for (const sessionID of installed.keys()) {
        try {
          await context.session.instructions.entry.remove({ sessionID, key: MONITOR_STATUS_KEY })
        } catch (error) {
          log("[v2] failed to remove monitor status entry", { sessionID, error })
        }
      }
    },
  }
}

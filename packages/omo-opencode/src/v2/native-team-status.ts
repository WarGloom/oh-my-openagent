import type { TeamModeStatusInjectorHook } from "../hooks/team-mode-status-injector/hook"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration } from "./context-types"
import { toV1ToolName } from "./tool-names"
import { subscribeTeamRuntimeChanges } from "@oh-my-opencode/team-core/team-state-store"

const TEAM_STATUS_KEY = "omo.team-status"

export async function registerNativeTeamStatus(
  context: V2PluginContext,
  hook: TeamModeStatusInjectorHook,
): Promise<V2Registration> {
  const sessions = new Map<string, boolean>()
  let disposed = false
  let queue = Promise.resolve()
  const prompt = await context.session.hook("prompt", async (event) => {
    const status = hook.nativeStatusForPrompt([{ type: "text", text: event.prompt.text }])
    if (status === undefined) return
    await context.session.instructions.entry.put({ sessionID: event.sessionID, key: TEAM_STATUS_KEY, value: status })
    if (!sessions.has(event.sessionID)) sessions.set(event.sessionID, false)
  })
  const tool = await context.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" || !sessions.has(event.sessionID)) return
    const name = toV1ToolName(event.tool)
    if (name === "team_create") {
      if (await hook.nativeHasActiveTeam(event.sessionID)) sessions.set(event.sessionID, true)
      return
    }
    if (name !== "team_delete") return
    if (await hook.nativeHasActiveTeam(event.sessionID)) return
    await context.session.instructions.entry.remove({ sessionID: event.sessionID, key: TEAM_STATUS_KEY })
    sessions.delete(event.sessionID)
  })
  const off = subscribeTeamRuntimeChanges(() => {
    queue = queue.then(async () => {
      if (disposed) return
      for (const [sessionID, observed] of sessions) {
        const active = await hook.nativeHasActiveTeam(sessionID)
        if (disposed || !sessions.has(sessionID)) continue
        if (active) sessions.set(sessionID, true)
        else if (observed) {
          await context.session.instructions.entry.remove({ sessionID, key: TEAM_STATUS_KEY })
          sessions.delete(sessionID)
        }
      }
    }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error
      log("[v2] failed to refresh team status", { error })
    })
  })
  return {
    dispose: async () => {
      disposed = true
      off()
      await tool.dispose()
      await prompt.dispose()
      await queue
      for (const sessionID of sessions.keys()) {
        try {
          await context.session.instructions.entry.remove({ sessionID, key: TEAM_STATUS_KEY })
        } catch (error) {
          log("[v2] failed to remove team status entry", { sessionID, error })
        }
      }
      sessions.clear()
    },
  }
}

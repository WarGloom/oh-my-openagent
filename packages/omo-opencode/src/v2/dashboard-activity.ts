import { readActiveLoop } from "../features/tui-sidebar/loop-reader"
import type { V2PluginContext, V2SessionInfo } from "./context-types"
import type { DashboardSnapshot } from "./dashboard-channel"

export async function projectDashboardActivity(
  context: V2PluginContext,
  session: V2SessionInfo,
  relatedSessionIDs: readonly string[],
): Promise<DashboardSnapshot["activity"]> {
  const ids = new Set(relatedSessionIDs.filter((id) => id !== session.id))
  const sessions = [session]
  for (const sessionID of ids) {
    try {
      sessions.push(await context.session.get({ sessionID }))
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  const loop = readActiveLoop(context.location.directory)
  return {
    agents: sessions
      .filter((info) => info.time.busy !== undefined && info.time.busy > (info.time.idle ?? 0))
      .map((info) => ({ name: info.agent?.toLowerCase() ?? info.id, status: "busy" })),
    loop: loop.kind === "live" ? { ...loop, activeGoal: null } : null,
  }
}

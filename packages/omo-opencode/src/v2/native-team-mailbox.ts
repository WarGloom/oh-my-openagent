import type { TeamMailboxInjectorHook } from "../hooks/team-mailbox-injector/hook"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration } from "./context-types"

export async function registerNativeTeamMailbox(context: V2PluginContext, hook: TeamMailboxInjectorHook): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    try {
      await hook.nativeDeliver(event.sessionID, async (message) => {
        await context.session.synthetic({ ...message, delivery: "steer", resume: true })
      })
    } catch (error) {
      log("[v2] team mailbox admission failed", { sessionID: event.sessionID, error })
    }
  })
}

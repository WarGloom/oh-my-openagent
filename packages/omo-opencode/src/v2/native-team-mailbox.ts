import type { TeamMailboxInjectorHook } from "../hooks/team-mailbox-injector/hook"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration } from "./context-types"
import { admitNativeTeamMessage } from "./native-team-jobs"
import { lookupTeamSession } from "../features/team-mode/team-session-registry"

export async function registerNativeTeamMailbox(context: V2PluginContext, hook: TeamMailboxInjectorHook): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    try {
      await hook.nativeDeliver(event.sessionID, async (message) => {
        const member = lookupTeamSession(event.sessionID)
        if (!member) throw new Error("Native team delivery requires registered membership")
        await admitNativeTeamMessage(context, message, { teamRunId: member.teamRunId, memberName: member.memberName })
      })
    } catch (error) {
      log("[v2] team mailbox admission failed", { sessionID: event.sessionID, error })
    }
  })
}

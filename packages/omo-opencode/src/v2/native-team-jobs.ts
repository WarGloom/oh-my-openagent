import type { V2MailboxAdmission } from "@oh-my-opencode/team-core/team-mailbox/v2-delivery"
import type { BackgroundManager } from "../features/background-agent/manager"
import { log } from "../shared/logger"
import type { V2PluginContext, V2SyntheticInput } from "./context-types"

const managers = new WeakMap<V2PluginContext, BackgroundManager>()
const deferredWakes = new WeakMap<V2PluginContext, Map<string, V2SyntheticInput>>()

function scheduleLeadWake(context: V2PluginContext, message: V2SyntheticInput, delayMs: number): void {
  const pending = deferredWakes.get(context) ?? new Map<string, V2SyntheticInput>()
  deferredWakes.set(context, pending)
  const { sessionID } = message
  const alreadyScheduled = pending.has(sessionID)
  pending.set(sessionID, message)
  if (alreadyScheduled) return

  setTimeout(() => {
    const latest = pending.get(sessionID)
    pending.delete(sessionID)
    if (!latest) return
    // Earlier steers are ahead of this one in the host inbox. The host wakes only if this ID is still pending.
    void context.session.synthetic({ ...latest, resume: true }).catch((error: unknown) => {
      log("[v2] deferred team lead wake failed", { sessionID, error: error instanceof Error ? error.message : String(error) })
    })
  }, delayMs).unref()
}

export function bindNativeTeamJobs(context: V2PluginContext, manager: BackgroundManager): void {
  managers.set(context, manager)
}

export async function admitNativeTeamMessage(
  context: V2PluginContext,
  message: V2MailboxAdmission,
  identity: { readonly teamRunId: string; readonly memberName: string },
): Promise<void> {
  const child = await context.session.get({ sessionID: message.sessionID })
  if (!child.parentID) {
    const { sessionID, id, text, wakeAfterMs = 0 } = message
    const input = { sessionID, id, text, delivery: "steer" } as const
    await context.session.synthetic({ ...input, resume: wakeAfterMs === 0 })
    if (wakeAfterMs > 0) scheduleLeadWake(context, input, wakeAfterMs)
    return
  }
  const manager = managers.get(context)
  const task = manager?.findBySession(message.sessionID)
  if (!manager?.nativeJobs || !task || task.teamRunId !== identity.teamRunId)
    throw new Error("Native team member has no matching task owner")
  if (!task.nativeProvisioningAdmissionID)
    throw new Error("Native team member has no authenticated provisioning admission")
  const parent = await context.session.get({ sessionID: child.parentID })
  await manager.resume({
    sessionId: message.sessionID,
    parentSessionId: child.parentID,
    parentMessageId: message.id,
    parentAgent: parent.agent,
    prompt: message.text,
    system: task.skillContent,
    nativePromptID: message.id,
    nativeInvocation: {
      kind: "team",
      agent: parent.agent ?? "",
      invocationID: message.id,
      teamRunID: identity.teamRunId,
      member: identity.memberName,
      provisioningAdmissionID: task.nativeProvisioningAdmissionID,
    },
    nativeCompletion: "none",
    nativeMode: "background",
  })
}

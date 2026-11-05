import type { BackgroundManager } from "../features/background-agent/manager"
import type { V2PluginContext } from "./context-types"

const managers = new WeakMap<V2PluginContext, BackgroundManager>()

export function bindNativeTeamJobs(context: V2PluginContext, manager: BackgroundManager): void {
  managers.set(context, manager)
}

export async function admitNativeTeamMessage(
  context: V2PluginContext,
  message: {
    readonly sessionID: string
    readonly id: string
    readonly text: string
  },
  identity: { readonly teamRunId: string; readonly memberName: string },
): Promise<void> {
  const child = await context.session.get({ sessionID: message.sessionID })
  if (!child.parentID) {
    await context.session.synthetic({ ...message, delivery: "steer", resume: true })
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

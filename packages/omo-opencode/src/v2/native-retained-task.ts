import type { BackgroundTask } from "../features/background-agent/types"
import type { V2PluginContext } from "./context-types"
import type { NativeSubagentDomain } from "./native-subagent-types"

export class NativeContinuationRecoveryError extends Error {
  constructor(readonly reason: string) {
    super(`Retained-session recovery denied: ${reason}`)
    this.name = "NativeContinuationRecoveryError"
  }
}

export async function recoverNativeTask(
  owner: { readonly context: V2PluginContext; readonly domain: NativeSubagentDomain },
  request: { readonly sessionID: string; readonly parentSessionID: string; readonly archived?: BackgroundTask },
  durable?: BackgroundTask,
): Promise<BackgroundTask | undefined> {
  const task = durable ?? request.archived
  if (!task) return undefined
  const archived = request.archived
  if (
    durable &&
    archived &&
    (durable.id !== archived.id ||
      durable.agent !== archived.agent ||
      durable.category !== archived.category ||
      durable.model?.providerID !== archived.model?.providerID ||
      durable.model?.modelID !== archived.model?.modelID ||
      durable.model?.variant !== archived.model?.variant ||
      durable.nativeAdmissionID !== archived.nativeAdmissionID ||
      durable.nativeRun?.generation !== archived.nativeRun?.generation)
  ) {
    throw new NativeContinuationRecoveryError("retained task identity or generation mismatch")
  }
  if (
    task.sessionId !== request.sessionID ||
    task.parentSessionId !== request.parentSessionID ||
    task.status !== "completed" ||
    !task.agent ||
    !task.model ||
    !task.nativeAdmissionID ||
    !task.nativeRun ||
    task.nativeRun.childSessionID !== request.sessionID
  ) {
    throw new NativeContinuationRecoveryError("no owned completed native task with trusted metadata")
  }
  const receipt = await owner.domain.get({ admissionID: task.nativeAdmissionID })
  if (
    !receipt ||
    receipt.parentSessionID !== request.parentSessionID ||
    receipt.childSessionID !== request.sessionID ||
    receipt.admissionID !== task.nativeAdmissionID ||
    receipt.run?.generation !== task.nativeRun.generation ||
    receipt.run.childSessionID !== request.sessionID ||
    receipt.status !== "completed" ||
    receipt.revoked
  ) {
    throw new NativeContinuationRecoveryError("native admission is missing, active, cancelled, revoked or mismatched")
  }
  if (task.nativeProvisioningAdmissionID) {
    const anchor = await owner.domain.get({ admissionID: task.nativeProvisioningAdmissionID })
    if (!anchor || anchor.revoked || anchor.status === "cancelled")
      throw new NativeContinuationRecoveryError("provisioning anchor revoked or unavailable")
  }
  const receipts = await owner.domain.reconcile({ parentSessionID: request.parentSessionID })
  if (
    receipts.some(
      (entry) =>
        entry.childSessionID === request.sessionID &&
        (entry.status === "authorizing" ||
          entry.status === "prepared" ||
          entry.status === "accepted" ||
          entry.status === "running"),
    )
  ) {
    throw new NativeContinuationRecoveryError("child has another active native admission")
  }
  const child = await owner.context.session.get({ sessionID: request.sessionID })
  if (
    child.id !== request.sessionID ||
    child.parentID !== request.parentSessionID ||
    child.agent !== task.agent ||
    child.model?.providerID !== task.model.providerID ||
    child.model.id !== task.model.modelID ||
    child.model.variant !== task.model.variant
  ) {
    throw new NativeContinuationRecoveryError("child ownership, agent or model mismatch")
  }
  if (child.time.busy !== undefined && child.time.busy > (child.time.idle ?? 0)) {
    throw new NativeContinuationRecoveryError("child session is busy")
  }
  return task
}

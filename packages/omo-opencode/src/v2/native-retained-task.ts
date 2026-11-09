import type { BackgroundTask } from "../features/background-agent/types"
import type { V2ModelRef, V2PluginContext } from "./context-types"
import type { NativeSubagentDomain } from "./native-subagent-types"
import { normalizeReasoning } from "@oh-my-opencode/model-core"

function retainedVariant(
  model: { readonly variant?: string; readonly reasoning?: string } | undefined,
): string | undefined {
  const selected = model?.variant ?? model?.reasoning
  if (selected === undefined) return undefined
  const normalized = normalizeReasoning(selected)
  return normalized.level === "auto" ? undefined : (normalized.level ?? normalized.passthrough)
}

function sameModel(left: V2ModelRef | undefined, right: V2ModelRef | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.providerID === right.providerID &&
    left.id === right.id &&
    retainedVariant(left) === retainedVariant(right)
  )
}

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
      durable.parentSessionId !== archived.parentSessionId ||
      durable.sessionId !== archived.sessionId ||
      durable.nativeProvisioningAdmissionID !== archived.nativeProvisioningAdmissionID ||
      durable.nativeAdmissionID !== archived.nativeAdmissionID ||
      durable.nativeRun?.childSessionID !== archived.nativeRun?.childSessionID ||
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
    !child.model
  ) {
    throw new NativeContinuationRecoveryError("child ownership, agent or model mismatch")
  }
  if (child.time.busy !== undefined && child.time.busy > (child.time.idle ?? 0)) {
    throw new NativeContinuationRecoveryError("child session is busy")
  }
  const model = { providerID: task.model.providerID, id: task.model.modelID, variant: retainedVariant(task.model) }
  const archivedModel = archived?.model && {
    providerID: archived.model.providerID,
    id: archived.model.modelID,
    variant: retainedVariant(archived.model),
  }
  if (!sameModel(model, child.model) || (archived && !sameModel(model, archivedModel))) {
    if (!task.startedAt)
      throw new NativeContinuationRecoveryError("model transition has no retained execution boundary")
    const startedAt = task.startedAt.getTime()
    const switches = (await owner.context.session.context({ sessionID: request.sessionID }))
      .filter((entry) => entry.type === "model-switched")
      .filter((entry) => entry.time.created >= startedAt)
    let selected: V2ModelRef = model
    let archiveConnected = !archived || sameModel(model, archivedModel)
    for (const entry of switches) {
      if (!sameModel(selected, entry.previous))
        throw new NativeContinuationRecoveryError("model transition history is inconsistent")
      selected = entry.model
      archiveConnected ||= sameModel(selected, archivedModel)
    }
    if (!switches.length || !archiveConnected || !sameModel(selected, child.model)) {
      throw new NativeContinuationRecoveryError(
        "model transition history does not prove the retained and current selections",
      )
    }
  }
  return task
}

import { createHash } from "node:crypto"
import type { BackgroundTask, LaunchInput, ResumeInput } from "../features/background-agent/types"
import type { NativeBackgroundJobs, NativeRestoredTask } from "../features/background-agent/native-lifecycle"
import type { TaskPromptBody } from "../features/background-agent/spawner/task-prompt-body"
import { applySessionPromptParams } from "../shared/session-prompt-params-helpers"
import { setSessionTools } from "../shared/session-tools-store"
import { registerDelegatedChildSessionBootstrap } from "../shared/delegated-child-session-bootstrap"
import { normalizeAction } from "./config-bridge/migrate-agent"
import { lowerReasoningForModel } from "../shared/agent-variant"
import type { V2PluginContext } from "./context-types"
import type { NativeSubagentDomain, NativeSubagentReceipt, NativeSubagentSkillSelection } from "./native-subagent-types"

export type NativeDelegationSkills = {
  readonly text: string
  readonly activationIDs: readonly string[]
  readonly selections: readonly NativeSubagentSkillSelection[]
}

export type NativeSubagentJobsDeps = {
  readonly activateSkills: (task: BackgroundTask) => Promise<NativeDelegationSkills>
  readonly restoreSkills: (task: BackgroundTask) => Promise<{ readonly text: string }>
  readonly save: (task: BackgroundTask) => Promise<void>
}

export class V2NativeSubagentJobs implements NativeBackgroundJobs {
  private stopped = false
  constructor(
    private readonly context: V2PluginContext,
    private readonly domain: NativeSubagentDomain,
    private readonly deps: NativeSubagentJobsDeps,
  ) {}

  async prepare(task: BackgroundTask, input: LaunchInput | ResumeInput, maxDepth: number): Promise<void> {
    const invocation = input.nativeInvocation
    if (!invocation) throw new Error("Native delegation requires its authentic tool, command or team invocation")
    const parent = await this.context.session.get({ sessionID: input.parentSessionId })
    const existingModel = task.sessionId
      ? (await this.context.session.get({ sessionID: task.sessionId })).model
      : undefined
    const variant =
      task.model?.reasoning !== undefined
        ? lowerReasoningForModel(task.model.reasoning, task.model).variant
        : task.model?.variant
    const model =
      existingModel ??
      (task.model
        ? { providerID: task.model.providerID, id: task.model.modelID, ...(variant ? { variant } : {}) }
        : parent.model)
    if (!model) throw new Error("Native delegation requires a resolved model")
    const invocationID =
      invocation.kind === "tool" ? `${invocation.messageID}:${invocation.toolCallID}` : invocation.invocationID
    const admissionID = `omo:${task.id}:${invocationID}`
    const previous = task.nativeAdmissionID === admissionID ? await this.domain.get({ admissionID }) : undefined
    const receipt =
      previous ??
      (await this.domain.prepare(
        {
          admissionID,
          parentSessionID: input.parentSessionId,
          agent: task.agent,
          model,
          maxDepth,
          description: task.description,
          invocation,
          target: task.sessionId
            ? { kind: "existing", sessionID: task.sessionId }
            : {
                kind: "create",
                ...(task.cwd ? { location: { directory: task.cwd } } : {}),
                ...(task.sessionPermission
                  ? {
                      permissions: task.sessionPermission.map((rule) => ({
                        action: normalizeAction(rule.permission),
                        resource: rule.pattern,
                        effect: rule.action,
                      })),
                    }
                  : {}),
              },
        },
        { signal: input.nativeSignal },
      ))
    if (receipt.status === "cancelled" || receipt.status === "error")
      throw new Error(receipt.error ?? `Native preparation ${receipt.status}`)
    task.nativeAdmissionID = receipt.admissionID
    if (invocation.kind === "tool" && invocation.team) task.nativeProvisioningAdmissionID ??= receipt.admissionID
    task.nativePromptID =
      "nativePromptID" in input && input.nativePromptID
        ? input.nativePromptID
        : `msg_${createHash("sha256").update(admissionID).digest("hex").slice(0, 26)}`
    task.nativeInvocation = invocation
    task.nativeRun = receipt.run
    task.sessionId = receipt.childSessionID
    task.model = { ...task.model, providerID: model.providerID, modelID: model.id, variant: model.variant }
    await this.deps.save(task)
  }

  async start(task: BackgroundTask, body: TaskPromptBody): Promise<"started" | "suspended"> {
    if (this.stopped) return "suspended"
    if (!task.nativeAdmissionID || !task.sessionId) throw new Error("Native task was not prepared")
    if (task.nativeAcceptedSkillsAdmissionID !== task.nativeAdmissionID) {
      const skills = await this.deps.activateSkills(task)
      task.nativeSkillActivationIDs = [...new Set([...(task.nativeSkillActivationIDs ?? []), ...skills.activationIDs])]
      task.nativeSkillSelections = skills.selections
      task.nativeAcceptedSkillsAdmissionID = task.nativeAdmissionID
      await this.deps.save(task)
    }
    if (this.stopped) return "suspended"
    // Accepted snapshots must still exist for this child and agent; their content reaches the model only through native prompt placement.
    await this.deps.restoreSkills(task)
    const system = body.system ?? ""
    if (system)
      await this.context.session.instructions.entry.put({
        sessionID: task.sessionId,
        key: "omo-delegation",
        value: system,
      })
    const child = await this.context.session.get({ sessionID: task.sessionId })
    await this.context.session.update({
      sessionID: task.sessionId,
      permissions: [
        ...(child.permissions ?? []),
        ...Object.entries(body.tools)
          .filter(([, enabled]) => !enabled)
          .map(([action]) => ({ action: normalizeAction(action), resource: "*", effect: "deny" as const })),
      ],
    })
    setSessionTools(task.sessionId, body.tools)
    if (task.model) applySessionPromptParams(task.sessionId, task.model)
    registerDelegatedChildSessionBootstrap({
      sessionID: task.sessionId,
      promptText: task.prompt,
      fallbackChain: task.fallbackChain,
      category: task.category,
      system,
      tools: body.tools,
    })
    if (this.stopped) return "suspended"
    const receipt = await this.domain.start({
      admissionID: task.nativeAdmissionID,
      promptID: task.nativePromptID,
      prompt: {
        ...(task.nativePrompt ?? { text: body.parts.map((part) => part.text).join("\n\n") }),
        skills: task.nativeSkillSelections,
      },
      delivery: "steer",
      mode: "background",
      completion: task.nativeCompletion ?? (task.teamRunId ? "none" : "parent"),
      metadata: { ...task.nativeMetadata, omoTaskID: task.id, category: task.category, teamRunId: task.teamRunId },
    })
    task.nativeRun = receipt.run
    if (receipt.status === "cancelled" || receipt.status === "error")
      throw new Error(receipt.error ?? `Native admission ${receipt.status}`)
    if (!task.nativeRun) throw new Error("Native start returned no execution generation")
    await this.deps.save(task)
    return "started"
  }

  async cancel(task: BackgroundTask): Promise<void> {
    if (!task.nativeAdmissionID) throw new Error("Native task was not prepared")
    await this.domain.cancel(task.nativeRun ? { run: task.nativeRun } : { admissionID: task.nativeAdmissionID })
  }

  async revokeProvisioning(task: BackgroundTask): Promise<void> {
    if (!task.nativeProvisioningAdmissionID) return
    const receipt = await this.domain.cancel({ admissionID: task.nativeProvisioningAdmissionID })
    if (!receipt.revoked) throw new Error("Native provisioning anchor was not revoked")
  }

  async wait(task: BackgroundTask): Promise<NativeSubagentReceipt> {
    if (!task.nativeRun) throw new Error("Native task has no execution generation")
    const result = await this.domain.wait({ run: task.nativeRun })
    if (result.timedOut) throw new Error("Native wait ended without a terminal receipt")
    return result.receipt
  }

  async restore(
    tasks: readonly BackgroundTask[],
    reconciled: (states: readonly NativeRestoredTask[]) => Promise<void>,
  ): Promise<void> {
    const receipts = await this.domain.reconcile()
    const states: NativeRestoredTask[] = []
    for (const task of tasks) {
      if (!task.nativeAdmissionID) continue
      const receipt =
        receipts.find((entry) => entry.admissionID === task.nativeAdmissionID) ??
        (await this.domain.get({ admissionID: task.nativeAdmissionID }))
      if (!receipt) throw new Error(`Native admission missing during restoration: ${task.nativeAdmissionID}`)
      states.push({ task, receipt })
      task.nativeRun = receipt.run
      if (receipt.run && (receipt.status === "running" || receipt.status === "accepted")) task.status = "running"
      if (!receipt.run) {
        task.status = receipt.status === "prepared" ? "pending" : "error"
        if (task.status === "error") task.error = receipt.error ?? "Native authorization did not finish before restart"
      }
    }
    await reconciled(states)
    for (const { task, receipt } of states) {
      if (!receipt.run) continue
      await this.deps.restoreSkills(task)
      const system = task.skillContent
      if (system && task.sessionId)
        await this.context.session.instructions.entry.put({
          sessionID: task.sessionId,
          key: "omo-delegation",
          value: system,
        })
      await this.domain.ready({ run: receipt.run })
    }
  }

  stop(): void {
    this.stopped = true
  }
}

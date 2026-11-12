import type { DelegateTaskArgs, ToolContextWithMetadata, DelegatedModelConfig } from "./types"
import type { ExecutorContext, ParentContext } from "./executor-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { buildTaskPrompt } from "./prompt-builder"
import { getPersistedBackgroundTaskDescription } from "./background-task-description"
import { getSessionTools } from "../../shared/session-tools-store"
import { getAgentConfigKey, stripAgentListSortPrefix } from "../../shared/agent-display-names"
import { migrateToolsToPermission } from "../../shared/permission-compat"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { subagentSessions } from "../../features/claude-code-session-state"
import { claimNativeContinuation } from "./native-continuation"
import {
  ExecutorRequirementError,
  assertRequiredModel,
  requiredModelFromMetadata,
} from "../../shared/delegated-executor-requirement"

export async function executeNativeDelegate(input: {
  readonly args: DelegateTaskArgs
  readonly ctx: ToolContextWithMetadata
  readonly executor: ExecutorContext
  readonly parent: ParentContext
  readonly agent?: string
  readonly model?: DelegatedModelConfig
  readonly system?: string
  readonly fallbackChain?: FallbackEntry[]
}): Promise<string> {
  const { args, ctx, executor, parent } = input
  if (!ctx.callID) throw new Error("Native delegation requires the host tool call ID")
  const nativeInvocation = { kind: "tool" as const, agent: ctx.agent, messageID: ctx.messageID, toolCallID: ctx.callID }
  const continuation = args.task_id
    ? await claimNativeContinuation(executor.manager, args.task_id, parent.sessionID)
    : undefined
  try {
    const existing = continuation?.task
    const agent = existing?.agent ?? stripAgentListSortPrefix(input.agent ?? "")
    const retainedModel = requiredModelFromMetadata(existing?.nativeMetadata)
    assertRequiredModel(retainedModel, args.required_model ?? retainedModel)
    const requiredModel = retainedModel ?? args.required_model
    if (existing) {
      if (
        (args.requested_subagent_type &&
          getAgentConfigKey(args.requested_subagent_type) !== getAgentConfigKey(existing.agent)) ||
        (args.category && args.category !== existing.category)
      )
        throw new ExecutorRequirementError("agent_conflict")
      assertRequiredModel(requiredModel, existing.model && `${existing.model.providerID}/${existing.model.modelID}`)
    } else assertRequiredModel(requiredModel, input.model && `${input.model.providerID}/${input.model.modelID}`)
    const nativeMetadata = requiredModel ? { ...existing?.nativeMetadata, requiredModel } : existing?.nativeMetadata
    const task = existing
      ? await executor.manager.resume({
          sessionId: args.task_id ?? "",
          prompt: args.prompt,
          system: args.load_skills.length ? input.system : existing.skillContent,
          parentSessionId: parent.sessionID,
          parentMessageId: parent.messageID,
          parentAgent: parent.agent,
          parentModel: parent.model,
          nativeInvocation,
          nativeMetadata,
          nativeSignal: ctx.abort,
          skills: args.load_skills.length ? args.load_skills : existing.skills,
          nativeInheritedPermit: !args.run_in_background && subagentSessions.has(parent.sessionID),
          nativeCompletion: args.run_in_background ? "parent" : "none",
          nativeMode: args.run_in_background ? "background" : "foreground",
        })
      : await executor.manager.launch({
          decisionId: args.decisionId,
          description: getPersistedBackgroundTaskDescription(args, agent),
          prompt: buildTaskPrompt(args.prompt, agent, executor.sisyphusAgentConfig?.tdd),
          agent,
          parentSessionId: parent.sessionID,
          parentMessageId: parent.messageID,
          parentModel: parent.model,
          parentAgent: parent.agent,
          parentTools: getSessionTools(parent.sessionID),
          model: input.model,
          fallbackChain: input.fallbackChain,
          skillContent: input.system,
          skills: args.load_skills,
          category: args.category,
          nativeMetadata,
          sessionPermission: QUESTION_DENIED_SESSION_PERMISSION,
          userPermission: input.model?.tools ? migrateToolsToPermission(input.model.tools) : undefined,
          nativeInvocation,
          nativeSignal: ctx.abort,
          nativeCompletion: args.run_in_background ? "parent" : "none",
          nativeMode: args.run_in_background ? "background" : "foreground",
          nativeInheritedPermit: !args.run_in_background && subagentSessions.has(parent.sessionID),
        })
    await publishToolMetadata(ctx, {
      title: args.description,
      metadata: {
        sessionId: task.sessionId,
        taskId: task.sessionId,
        backgroundTaskId: task.id,
        category: args.category ?? task.category,
        agent,
        load_skills: args.load_skills,
        run_in_background: args.run_in_background,
        prompt: args.prompt,
        description: args.description,
        command: args.command,
        ...(requiredModel ? { required_model: requiredModel } : {}),
        ...(args.requested_subagent_type ? { requested_subagent_type: args.requested_subagent_type } : {}),
        model: resolveMetadataModel(input.model ?? task.model, parent.model),
      },
    })
    const metadata = task.sessionId
      ? buildTaskMetadataBlock({ sessionId: task.sessionId, backgroundTaskId: task.id, agent, category: task.category })
      : ""
    if (args.run_in_background)
      return `Background Task ID: ${task.id}\nDescription: ${task.description}\nAgent: ${agent}\nStatus: ${task.status}\nInspect the delivered completion result. Use background_output only if output is missing or truncated, or for history or diagnostics.\n${metadata}`
    try {
      const completed = await executor.manager.waitForNativeTask(task.id, ctx.abort)
      if (completed.status !== "completed") throw new Error(completed.error ?? `Native task ${completed.status}`)
      return `${completed.result ?? ""}\n\n${metadata}`
    } catch (error) {
      if (ctx.abort.aborted)
        await executor.manager.cancelTask(task.id, { source: "native-sync-abort", skipNotification: true })
      throw error
    }
  } finally {
    continuation?.release()
  }
}

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { DelegatedModelConfig, ToolContextWithMetadata, DelegateTaskToolOptions } from "./types"
import { log } from "../../shared/logger"
import { buildSystemContent } from "./prompt-builder"
import {
  resolveSkillContent,
  resolveParentContext,
  executeBackgroundContinuation,
  executeSyncContinuation,
  resolveCategoryExecution,
  resolveSubagentExecution,
  executeUnstableAgentTask,
  executeBackgroundTask,
  executeSyncTask,
} from "./executor"
import { prepareDelegateTaskArgs } from "./tool-argument-preparation"
import { createDelegateTaskPresentation } from "./tool-description"
import { buildDelegateTaskArgsSchema } from "./task-args-schema"
import { isPlanAgent } from "./constants"
import { selectAgentWithJev } from "./jev-routing"
import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder"
import { mergeNativeSkillInfos, type NativeSkillEntry } from "../skill/native-skills"
import type { SkillInfo } from "../skill/types"
import { executeNativeDelegate } from "./native-execution"
import { getJevRoutingEligibility } from "./jev-routing"
import { mergeCategories } from "../../shared/merge-categories"

const RUNTIME_PLAN_AGENT_DISABLED_MESSAGE = `OpenCode runtime plan agent is disabled in OMO task routing. Use metis for pre-plan sanity, momus for saved .omo/plans/*.md review, oracle for hard architecture/debugging, or a category for execution.`

async function loadNativeSkillEntries(
  nativeSkills: DelegateTaskToolOptions["nativeSkills"] | undefined,
): Promise<NativeSkillEntry[]> {
  if (!nativeSkills) return []
  try {
    const list = await nativeSkills.all()
    return Array.isArray(list) ? list : []
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    log("[delegate-task] nativeSkills.all() failed; skipping native skills", { error: errorMessage })
    return []
  }
}

function buildPromptNativeSkillInfos(
  availableSkills: AvailableSkill[],
  nativeSkillEntries: NativeSkillEntry[],
  disabledSkills: ReadonlySet<string> | undefined,
): Array<{ name: string; description: string; location: string }> {
  if (nativeSkillEntries.length === 0) return []
  const availableSkillInfos: SkillInfo[] = availableSkills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: undefined,
    scope: skill.location === "plugin" ? "builtin" : skill.location,
  }))
  const initialCount = availableSkillInfos.length
  mergeNativeSkillInfos(availableSkillInfos, nativeSkillEntries, disabledSkills)
  return availableSkillInfos.slice(initialCount).map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: skill.location ?? "",
  }))
}

export { resolveCategoryConfig } from "./categories"
export type { SyncSessionCreatedEvent, DelegateTaskToolOptions, BuildSystemContentInput } from "./types"
export { buildSystemContent, buildTaskPrompt } from "./prompt-builder"

export function createDelegateTask(options: DelegateTaskToolOptions): ToolDefinition {
  const { availableCategories, availableSkills, categoryExamples, description } =
    createDelegateTaskPresentation(options)
  const delegateTaskArgsSchema = buildDelegateTaskArgsSchema(
    options.availableSubagentNames,
    Object.keys(options.jevRouting?.agent_ladders ?? {}),
  )

  return tool({
    description,
    args: delegateTaskArgsSchema,
    async execute(args, toolContext) {
      const originalContext = toolContext as ToolContextWithMetadata
      originalContext.abort?.throwIfAborted()
      const currentModelConfig = options.loadCurrentModelConfig?.()
      const agentOverrides = {
        ...(currentModelConfig === undefined ? options.agentOverrides : currentModelConfig.agents),
      }
      const modelOptions = {
        ...options,
        agentOverrides,
        userCategories: {
          ...(currentModelConfig === undefined ? options.userCategories : currentModelConfig.categories),
        },
        jevRouting: currentModelConfig === undefined ? options.jevRouting : currentModelConfig.jev_routing,
        sisyphusJuniorModel:
          currentModelConfig === undefined ? options.sisyphusJuniorModel : agentOverrides["sisyphus-junior"]?.model,
      }
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, originalContext)
      const ctx = originalContext
      const orchestratorCategory = delegateTaskArgs.category ?? "omitted"
      if (
        !delegateTaskArgs.task_id &&
        !delegateTaskArgs.category &&
        !delegateTaskArgs.subagent_type &&
        modelOptions.jevRouting &&
        modelOptions.jevRouting.mode !== "off" &&
        getJevRoutingEligibility({
          config: modelOptions.jevRouting,
          enabledCategories: mergeCategories(modelOptions.userCategories),
        }).validDefault
      )
        delegateTaskArgs.category = "auto"
      if (!delegateTaskArgs.task_id && !delegateTaskArgs.category && delegateTaskArgs.subagent_type) {
        const config = modelOptions.jevRouting
        const alias = delegateTaskArgs.subagent_type
        if (config?.agent_ladders && Object.hasOwn(config.agent_ladders, alias)) {
          const context = {
            config,
            client: options.client,
            directory: options.directory,
            categories: modelOptions.userCategories,
            agentOverrides,
            disabledAgents: options.disabledAgents,
            signal: ctx.abort,
          }
          const chosen = await selectAgentWithJev(alias, delegateTaskArgs.prompt, {
            ...context,
            modelRouting: delegateTaskArgs.model_routing,
          })
          if (!chosen) return `Unknown agent: "${alias}".`
          delegateTaskArgs.subagent_type = chosen
        }
      }

      if (!delegateTaskArgs.category && isPlanAgent(delegateTaskArgs.subagent_type)) {
        return RUNTIME_PLAN_AGENT_DISABLED_MESSAGE
      }

      const runInBackground = delegateTaskArgs.run_in_background === true

      const {
        content: skillContent,
        contents: skillContents,
        error: skillError,
      } = options.manager.nativeJobs
        ? { content: undefined, contents: undefined, error: undefined }
        : await resolveSkillContent(delegateTaskArgs.load_skills, {
            gitMasterConfig: options.gitMasterConfig,
            browserProvider: options.browserProvider,
            disabledSkills: options.disabledSkills,
            teamModeEnabled: options.teamModeEnabled,
            directory: options.directory,
            targetAgent: delegateTaskArgs.subagent_type,
            nativeSkills: options.nativeSkills,
            getLoadedSkills: options.getLoadedSkills,
          })
      if (skillError) {
        return skillError
      }
      const nativeSkillEntries = await loadNativeSkillEntries(options.nativeSkills)
      const nativeSkillInfos = buildPromptNativeSkillInfos(availableSkills, nativeSkillEntries, options.disabledSkills)

      const continuationSystemContent = buildSystemContent({
        skillContent,
        skillContents,
        availableCategories,
        availableSkills,
        nativeSkillInfos,
      })

      const parentContext = await resolveParentContext(ctx, options.client)

      if (delegateTaskArgs.task_id) {
        ctx.abort?.throwIfAborted()
        if (options.manager.nativeJobs)
          return executeNativeDelegate({
            args: delegateTaskArgs,
            ctx,
            executor: modelOptions,
            parent: parentContext,
            system: continuationSystemContent,
          })
        if (runInBackground) {
          return executeBackgroundContinuation(
            delegateTaskArgs,
            ctx,
            modelOptions,
            parentContext,
            continuationSystemContent,
          )
        }
        return executeSyncContinuation(
          delegateTaskArgs,
          ctx,
          modelOptions,
          parentContext,
          undefined,
          continuationSystemContent,
        )
      }

      if (!delegateTaskArgs.category && !delegateTaskArgs.subagent_type) {
        return `Invalid arguments: Must provide either category or subagent_type.`
      }

      let systemDefaultModel: string | undefined
      try {
        const openCodeConfig = await options.client.config.get()
        systemDefaultModel = (openCodeConfig as { data?: { model?: string } })?.data?.model
      } catch (error) {
        if (!(error instanceof Error)) throw error
        systemDefaultModel = undefined
      }

      const inheritedModel = parentContext.model
        ? `${parentContext.model.providerID}/${parentContext.model.modelID}`
        : undefined

      const routingOptions = {
        ...modelOptions,
        abortSignal: ctx.abort,
        jevParentSessionID: ctx.sessionID,
        jevOrchestratorCategory: orchestratorCategory,
      }

      let agentToUse: string
      let categoryModel: DelegatedModelConfig | undefined
      let categoryPromptAppend: string | undefined
      let modelInfo: import("../../features/task-toast-manager/types").ModelFallbackInfo | undefined
      let actualModel: string | undefined
      let isUnstableAgent = false
      let fallbackChain: import("../../shared/model-requirements").FallbackEntry[] | undefined
      let maxPromptTokens: number | undefined
      let routingNotice: string | undefined
      const withRoutingNotice = async (result: Promise<string>) => {
        const text = await result
        return routingNotice ? `${text}\n${routingNotice}` : text
      }

      if (delegateTaskArgs.category) {
        const resolution = await resolveCategoryExecution(
          delegateTaskArgs,
          routingOptions,
          inheritedModel,
          systemDefaultModel,
        )
        if (resolution.error) {
          return resolution.error
        }
        agentToUse = resolution.agentToUse
        categoryModel = resolution.categoryModel
        categoryPromptAppend = resolution.categoryPromptAppend
        modelInfo = resolution.modelInfo
        actualModel = resolution.actualModel
        isUnstableAgent = resolution.isUnstableAgent
        fallbackChain = resolution.fallbackChain
        maxPromptTokens = resolution.maxPromptTokens
        routingNotice = resolution.routingNotice

        const isRunInBackgroundExplicitlyFalse = isExplicitSyncRun(delegateTaskArgs.run_in_background)

        log("[task] unstable agent detection", {
          category: delegateTaskArgs.category,
          actualModel,
          isUnstableAgent,
          run_in_background_value: delegateTaskArgs.run_in_background,
          run_in_background_type: typeof delegateTaskArgs.run_in_background,
          isRunInBackgroundExplicitlyFalse,
          willForceBackground: isUnstableAgent && isRunInBackgroundExplicitlyFalse,
        })

        if (isUnstableAgent && isRunInBackgroundExplicitlyFalse) {
          ctx.abort?.throwIfAborted()
          const systemContent = buildSystemContent({
            skillContent,
            skillContents,
            categoryPromptAppend,
            agentName: agentToUse,
            maxPromptTokens,
            model: categoryModel,
            availableCategories,
            availableSkills,
            nativeSkillInfos,
          })
          if (options.manager.nativeJobs)
            return withRoutingNotice(
              executeNativeDelegate({
                args: { ...delegateTaskArgs, run_in_background: true },
                ctx,
                executor: modelOptions,
                parent: parentContext,
                agent: agentToUse,
                model: categoryModel,
                system: systemContent,
                fallbackChain,
              }),
            )
          return withRoutingNotice(
            executeUnstableAgentTask(
              delegateTaskArgs,
              ctx,
              modelOptions,
              parentContext,
              agentToUse,
              categoryModel,
              systemContent,
              actualModel,
              fallbackChain,
            ),
          )
        }
      } else {
        const resolution = await resolveSubagentExecution(
          delegateTaskArgs,
          modelOptions,
          parentContext.agent,
          categoryExamples,
          { defaultModel: systemDefaultModel ?? inheritedModel },
        )
        if (resolution.error) {
          return resolution.error
        }
        agentToUse = resolution.agentToUse
        categoryModel = resolution.categoryModel
        fallbackChain = resolution.fallbackChain
      }

      const systemContent = buildSystemContent({
        skillContent,
        skillContents,
        categoryPromptAppend,
        agentName: agentToUse,
        maxPromptTokens,
        model: categoryModel,
        availableCategories,
        availableSkills,
        nativeSkillInfos,
      })

      ctx.abort?.throwIfAborted()

      if (options.manager.nativeJobs)
        return withRoutingNotice(
          executeNativeDelegate({
            args: delegateTaskArgs,
            ctx,
            executor: modelOptions,
            parent: parentContext,
            agent: agentToUse,
            model: categoryModel,
            system: systemContent,
            fallbackChain,
          }),
        )

      if (runInBackground) {
        return withRoutingNotice(
          executeBackgroundTask(
            delegateTaskArgs,
            ctx,
            modelOptions,
            parentContext,
            agentToUse,
            categoryModel,
            systemContent,
            fallbackChain,
          ),
        )
      }

      return withRoutingNotice(
        executeSyncTask(
          delegateTaskArgs,
          ctx,
          modelOptions,
          parentContext,
          agentToUse,
          categoryModel,
          systemContent,
          modelInfo,
          fallbackChain,
        ),
      )
    },
  })
}

function isExplicitSyncRun(runInBackground: unknown): boolean {
  return runInBackground === false || runInBackground === "false"
}

import { recordJevRouting, recordNamedRoutingSkip } from "./jev-routing-ledger"
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
import { suggestDelegateSkills } from "./jev-skill-suggestions"
import { ExecutorRequirementError, assertRequiredModel } from "../../shared/delegated-executor-requirement"
import { resolveRequiredCategory } from "./required-category-resolution"
import { configuredContentFilterModel } from "./configured-content-filter-model"
import { getAvailableModelsForDelegateTask } from "./available-models"

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
      const skillsOmitted = args.load_skills === undefined
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, originalContext)
      if (
        delegateTaskArgs.completion_group !== undefined &&
        (!options.manager.nativeJobs || !delegateTaskArgs.run_in_background)
      ) {
        return "completion_group requires run_in_background: true on an OpenCode V2 host."
      }
      if (delegateTaskArgs.replaces_session_id) {
        if (delegateTaskArgs.task_id || !options.manager.nativeJobs)
          return "replaces_session_id requires a new OpenCode V2 child."
        const replaced = await options.client.session.get({ path: { id: delegateTaskArgs.replaces_session_id } })
        const info: unknown = replaced.data
        if (
          typeof info !== "object" ||
          info === null ||
          !("parentID" in info) ||
          info.parentID !== originalContext.sessionID
        )
          return "The replaced session must be a child of the current session."
      }
      const named = !delegateTaskArgs.category && delegateTaskArgs.subagent_type
      if (
        named &&
        !delegateTaskArgs.task_id &&
        (delegateTaskArgs.required_model || delegateTaskArgs.model_routing === false)
      ) {
        await recordNamedRoutingSkip({
          agent: named,
          surface: "task",
          parentSessionID: originalContext.sessionID,
          reason: delegateTaskArgs.required_model ? "explicit_model" : "opt_out",
        })
      }
      if (delegateTaskArgs.required_model && !options.manager.nativeJobs)
        throw new ExecutorRequirementError("unsupported_execution")
      if (
        delegateTaskArgs.required_model &&
        !delegateTaskArgs.task_id &&
        !(await getAvailableModelsForDelegateTask(options.client, true)).has(delegateTaskArgs.required_model)
      ) {
        throw new ExecutorRequirementError("no_eligible_executor")
      }
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

      let nativeSkillEntries: NativeSkillEntry[] | undefined
      if (
        skillsOmitted &&
        !delegateTaskArgs.task_id &&
        modelOptions.jevRouting?.mode === "active" &&
        delegateTaskArgs.model_routing !== false
      ) {
        nativeSkillEntries = await loadNativeSkillEntries(options.nativeSkills)
        const nativeInfos: SkillInfo[] = []
        mergeNativeSkillInfos(nativeInfos, nativeSkillEntries, options.disabledSkills, options.directory)
        const candidates = options.manager.nativeJobs ? nativeInfos : [...availableSkills, ...nativeInfos]
        delegateTaskArgs.load_skills = await suggestDelegateSkills({
          description: delegateTaskArgs.description,
          prompt: delegateTaskArgs.prompt,
          skills: candidates,
          disabledSkills: options.disabledSkills,
          config: modelOptions.jevRouting,
          modelRouting: delegateTaskArgs.model_routing,
          signal: ctx.abort,
        })
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
      nativeSkillEntries ??= await loadNativeSkillEntries(options.nativeSkills)
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
        trackHintDelivery: true,
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
      let routingHint: Promise<string | undefined> | undefined
      let finishRoutingHint: ((status: "delivered" | "missed_budget" | "not_produced") => void) | undefined
      const withRoutingNotice = async (result: Promise<string>) => {
        const text = await result
        if (!routingHint) return routingNotice ? `${text}\n${routingNotice}` : text
        // A foreground child outlasts the observation; a background launch waits for it only briefly.
        const budget = Promise.withResolvers<null>()
        const timer = setTimeout(() => budget.resolve(null), Math.min(modelOptions.jevRouting?.timeout_ms ?? 0, 750))
        const hint = await Promise.race([routingHint, budget.promise])
        clearTimeout(timer)
        finishRoutingHint?.(hint === null ? "missed_budget" : hint ? "delivered" : "not_produced")
        return [text, routingNotice, hint].filter(Boolean).join("\n")
      }

      const contentFilterModel = configuredContentFilterModel(delegateTaskArgs.required_model, agentOverrides)
      if (delegateTaskArgs.category) {
        const resolution = delegateTaskArgs.required_model
          ? await resolveRequiredCategory({
              args: delegateTaskArgs,
              context: routingOptions,
              inheritedModel,
              defaultModel: systemDefaultModel,
            })
          : await resolveCategoryExecution(delegateTaskArgs, routingOptions, inheritedModel, systemDefaultModel)
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
        routingHint = resolution.routingHint
        finishRoutingHint = resolution.finishRoutingHint

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
        if (
          delegateTaskArgs.requested_subagent_type !== delegateTaskArgs.subagent_type &&
          !delegateTaskArgs.required_model &&
          delegateTaskArgs.model_routing !== false &&
          delegateTaskArgs.subagent_type
        ) {
          await recordNamedRoutingSkip({
            agent: delegateTaskArgs.subagent_type,
            surface: "task",
            parentSessionID: ctx.sessionID,
            reason: "pinned_by_rule",
          })
        }
        const resolution = await resolveSubagentExecution(
          delegateTaskArgs,
          { ...modelOptions, requiredModel: contentFilterModel ? undefined : delegateTaskArgs.required_model },
          parentContext.agent,
          categoryExamples,
          {
            defaultModel: systemDefaultModel ?? inheritedModel,
            namedModelRouting:
              delegateTaskArgs.model_routing !== false &&
              !delegateTaskArgs.required_model &&
              delegateTaskArgs.requested_subagent_type === delegateTaskArgs.subagent_type
                ? { brief: delegateTaskArgs.prompt, parentSessionID: ctx.sessionID, signal: ctx.abort }
                : undefined,
          },
        )
        if (resolution.error) {
          return resolution.error
        }
        agentToUse = resolution.agentToUse
        categoryModel = contentFilterModel
          ? {
              ...resolution.categoryModel,
              ...contentFilterModel,
              reasoning: delegateTaskArgs.reasoning ?? contentFilterModel.reasoning,
              reasoningEffort: contentFilterModel.reasoningEffort,
            }
          : resolution.categoryModel
        fallbackChain = resolution.fallbackChain
        assertRequiredModel(
          delegateTaskArgs.required_model,
          categoryModel && `${categoryModel.providerID}/${categoryModel.modelID}`,
        )
        if (delegateTaskArgs.required_model) fallbackChain = []
        if (resolution.namedModelDecision) {
          delegateTaskArgs.decisionId = resolution.namedModelDecision.decision_id
          delegateTaskArgs.namedModelPlan = true
          await recordJevRouting(resolution.namedModelDecision)
        }
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

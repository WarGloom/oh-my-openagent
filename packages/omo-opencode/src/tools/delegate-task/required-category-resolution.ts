import { ExecutorRequirementError, assertRequiredModel } from "../../shared/delegated-executor-requirement"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { mergeCategories } from "../../shared/merge-categories"
import { getAvailableModelsForDelegateTask } from "./available-models"
import { resolveCategoryExecution, type CategoryResolutionResult } from "./category-resolver"
import { beginJevDecision, jevConfigGeneration } from "./jev-routing-context"
import { selectCategoryTierWithJev } from "./jev-routing"
import { SISYPHUS_JUNIOR_AGENT } from "./sisyphus-junior-agent"
import type { ExecutorContext } from "./executor-types"
import type { DelegateTaskArgs } from "./types"

export async function resolveRequiredCategory(input: {
  readonly args: DelegateTaskArgs
  readonly context: ExecutorContext
  readonly inheritedModel: string | undefined
  readonly defaultModel: string | undefined
}): Promise<CategoryResolutionResult> {
  const { args, context, inheritedModel, defaultModel } = input
  if (context.disabledAgents?.some((agent) => getAgentConfigKey(agent) === getAgentConfigKey(SISYPHUS_JUNIOR_AGENT))) {
    throw new ExecutorRequirementError("no_eligible_executor")
  }
  const available = await getAvailableModelsForDelegateTask(context.client)
  if (!args.required_model || !available.has(args.required_model))
    throw new ExecutorRequirementError("no_eligible_executor")
  if (args.category !== "auto") {
    const result = await resolveCategoryExecution(args, context, inheritedModel, defaultModel)
    if (result.error) return result
    assertRequiredModel(
      args.required_model,
      result.categoryModel && `${result.categoryModel.providerID}/${result.categoryModel.modelID}`,
    )
    return { ...result, fallbackChain: [] }
  }

  const categories = mergeCategories(context.userCategories)
  const userCategories =
    context.userCategories &&
    Object.fromEntries(
      Object.entries(context.userCategories).map(([name, config]) => [
        name,
        config.models_distribution === "round_robin" ? { ...config, models_distribution: undefined } : config,
      ]),
    )
  const eligible = new Map<string, CategoryResolutionResult>()
  for (const category of Object.keys(categories)) {
    const result = await resolveCategoryExecution(
      { ...args, category },
      { ...context, userCategories, jevRouting: undefined },
      inheritedModel,
      defaultModel,
    )
    if (
      !result.error &&
      result.categoryModel &&
      `${result.categoryModel.providerID}/${result.categoryModel.modelID}` === args.required_model
    ) {
      eligible.set(category, result)
    }
  }
  const first = eligible.keys().next().value
  if (!first) throw new ExecutorRequirementError("no_eligible_executor")
  const configured = context.jevRouting
  if (!configured) throw new ExecutorRequirementError("no_eligible_executor")
  const enabledCategories = Object.fromEntries(Object.entries(categories).filter(([name]) => eligible.has(name)))
  let notice: string | undefined
  const selected = await selectCategoryTierWithJev({
    brief: args.prompt,
    description: args.description,
    directory: context.directory,
    config: {
      ...configured,
      default: configured.default && eligible.has(configured.default) ? configured.default : first,
    },
    enabledCategories,
    modelRouting: args.model_routing,
    signal: context.abortSignal,
    decisionId: beginJevDecision(args),
    parentSessionId: context.jevParentSessionID,
    surface: context.jevSurface,
    orchestratorCategory: context.jevOrchestratorCategory ?? "auto",
    configGeneration: jevConfigGeneration(enabledCategories, {
      userCategories: context.userCategories,
      juniorModel: context.sisyphusJuniorModel,
    }),
    resolveDirectory: context.jevParentSessionID
      ? async () => {
          const parent = await context.client.session.get({ path: { id: context.jevParentSessionID ?? "" } })
          if (!parent.data?.directory) throw new RangeError("Parent session directory is unavailable")
          return parent.data.directory
        }
      : undefined,
    onFallback: (reason, category) => {
      notice = `Routing: Jev unavailable (${reason}); used default ${category}.`
    },
  })
  context.abortSignal?.throwIfAborted()
  const result = selected ? eligible.get(selected) : undefined
  if (!result) throw new ExecutorRequirementError("no_eligible_executor")
  args.category = selected
  return { ...result, fallbackChain: [], routingNotice: notice }
}

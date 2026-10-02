import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"
import { log } from "../../shared/logger"
import { normalizeModelFormat } from "../../shared/model-format-normalizer"
import { resolveSubagentAgentMatch } from "./subagent-agent-match"
import { resolveSubagentModel } from "./subagent-model-resolution"
import { validateSubagentRequest } from "./subagent-request-preflight"
import type { ResolveSubagentExecutionOptions, ResolveSubagentExecutionResult } from "./subagent-resolution-types"

export type { ResolveSubagentExecutionOptions, ResolveSubagentExecutionResult }

export async function resolveSubagentExecution(
  args: DelegateTaskArgs,
  executorCtx: ExecutorContext,
  parentAgent: string | undefined,
  categoryExamples: string,
  options: ResolveSubagentExecutionOptions = {},
): Promise<ResolveSubagentExecutionResult> {
  const preflight = validateSubagentRequest(args, parentAgent, categoryExamples, options)
  if (preflight.kind === "invalid") {
    return preflight.result
  }

  let agentToUse = preflight.agentName

  try {
    const agentMatch = await resolveSubagentAgentMatch(agentToUse, executorCtx, options)
    if (agentMatch.kind === "error") {
      return agentMatch.result
    }

    agentToUse = agentMatch.agentToUse
    const { categoryModel, fallbackChain } = await resolveSubagentModel(
      agentToUse,
      agentMatch.matchedAgent,
      executorCtx,
    )
    const reasoningModel =
      categoryModel ??
      (args.reasoning !== undefined && options.defaultModel ? normalizeModelFormat(options.defaultModel) : undefined)
    const delegatedModel =
      reasoningModel && args.reasoning !== undefined ? { ...reasoningModel, reasoning: args.reasoning } : categoryModel
    if (args.reasoning !== undefined && !delegatedModel) {
      log("[delegate-task] Dropping call reasoning: no model resolved for agent", {
        agent: agentToUse,
        reasoning: args.reasoning,
      })
    }
    return { agentToUse, categoryModel: delegatedModel, fallbackChain }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log("[delegate-task] Failed to resolve subagent execution", {
      requestedAgent: agentToUse,
      parentAgent,
      error: errorMessage,
    })

    return {
      agentToUse: "",
      categoryModel: undefined,
      error: `Failed to delegate to agent "${agentToUse}": ${errorMessage}`,
    }
  }
}

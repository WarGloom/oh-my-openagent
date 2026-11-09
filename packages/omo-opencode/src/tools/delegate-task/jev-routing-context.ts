import { createHash, randomUUID } from "node:crypto"
import { subscribeTaskLifecycle } from "../../features/background-agent/task-lifecycle"
import type { CategoriesConfig } from "../../config/schema"
import type { FallbackModels } from "../../config/schema/fallback-models"
import { recordJevRouting } from "./jev-routing-ledger"
import { isDeepHighEscalation } from "./openai-categories"
import type { DelegateTaskArgs } from "./types"

subscribeTaskLifecycle((event) => {
  const common = {
    schema_version: 1 as const,
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    decision_id: event.decisionId,
    attempt_id: event.attemptId,
    task_id: event.taskId,
    child_session_id: event.childSessionId,
  }
  switch (event.event) {
    case "attempt":
      recordJevRouting({ ...common, event: "attempt", cause: event.cause, resolved_model: event.resolvedModel })
      break
    case "outcome":
      recordJevRouting({
        ...common,
        event: "outcome",
        status: event.status === "completed" && isDeepHighEscalation(event.output ?? "") ? "escalated" : event.status,
        producing_model: event.producingModel,
      })
      break
    default: {
      const exhaustive: never = event
      throw new RangeError(`Unexpected lifecycle event: ${exhaustive}`)
    }
  }
})

export function beginJevDecision(args: DelegateTaskArgs): string {
  args.decisionId ??= randomUUID()
  return args.decisionId
}

export function jevConfigGeneration(
  categories: CategoriesConfig,
  overrides: {
    readonly userCategories?: CategoriesConfig
    readonly juniorModel?: string
    readonly juniorFallbackModels?: FallbackModels
  } = {},
): string {
  const mapping = Object.entries(categories)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([name]) => name !== "auto")
    .map(([name, category]) => {
      const explicit = overrides.userCategories?.[name]?.model
      const models = category.models ?? explicit ?? overrides.juniorModel ?? category.model ?? null
      const fallbacks = category.models
        ? []
        : (category.fallback_models ??
          (overrides.juniorModel && !explicit ? overrides.juniorFallbackModels : undefined) ??
          [])
      return [name, models, fallbacks]
    })
  return createHash("sha256").update(JSON.stringify(mapping)).digest("hex")
}

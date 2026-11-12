import { parseModelString } from "./model-string-parser"
import { getAgentConfigKey } from "./agent-display-names"

type RequirementFailure =
  "invalid_model" | "agent_conflict" | "model_mismatch" | "no_eligible_executor" | "unsupported_execution"

const messages = {
  invalid_model: "required_model must be an exact provider/model identity without a reasoning variant.",
  agent_conflict:
    "Conflicting executor selections. Use one registered subagent_type, or a category with its category executor.",
  model_mismatch:
    "The selected or retained executor does not satisfy required_model. Choose a matching configured executor or start a new task.",
  no_eligible_executor:
    "No eligible executor satisfies required_model. Choose an enabled category or registered agent that resolves to that exact provider/model.",
  unsupported_execution:
    "required_model requires V2 native delegation. This execution path cannot preserve the requirement through recovery.",
} as const

export class ExecutorRequirementError extends Error {
  readonly name = "ExecutorRequirementError"
  readonly code = "executor_requirement"

  constructor(readonly reason: RequirementFailure) {
    super(messages[reason])
  }
}

export function parseRequiredModel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new ExecutorRequirementError("invalid_model")
  const parsed = parseModelString(value)
  if (!parsed || parsed.variant !== undefined || `${parsed.providerID}/${parsed.modelID}` !== value) {
    throw new ExecutorRequirementError("invalid_model")
  }
  return value
}

export function assertRequiredModel(required: string | undefined, actual: string | undefined): void {
  if (required !== undefined && required !== actual) throw new ExecutorRequirementError("model_mismatch")
}

export function assertExecutorSelection(args: { readonly category?: unknown; readonly subagent_type?: unknown }): void {
  if (
    typeof args.category === "string" &&
    args.category &&
    typeof args.subagent_type === "string" &&
    args.subagent_type &&
    getAgentConfigKey(args.subagent_type) !== "sisyphus-junior"
  )
    throw new ExecutorRequirementError("agent_conflict")
}

export function requiredModelFromMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return parseRequiredModel(metadata?.requiredModel)
}

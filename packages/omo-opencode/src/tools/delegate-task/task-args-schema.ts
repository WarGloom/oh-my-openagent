import { tool } from "@opencode-ai/plugin"
import { BUILTIN_SUBAGENT_TYPES, isDirectSubagentTypeDisabled } from "./builtin-subagent-types"
import { isPlanAgent } from "./constants"

type StringSchema = InstanceType<typeof tool.schema.ZodString>
type OptionalStringSchema = ReturnType<StringSchema["optional"]>
type OptionalBooleanSchema = ReturnType<ReturnType<typeof tool.schema.boolean>["optional"]>
type OptionalStringArraySchema = ReturnType<ReturnType<typeof tool.schema.array<StringSchema>>["optional"]>
type EnumSchema = typeof tool.schema.enum extends { (values: string[]): infer T; (entries: never): unknown } ? T : never
type OptionalEnumSchema = EnumSchema extends { optional(): infer T } ? T : never

function buildSubagentTypeSchema(availableSubagentNames?: readonly string[], aliases: readonly string[] = []) {
  const describe =
    "Optional direct agent selection instead of a category. Omit both to use category auto when Jev routing is enabled. Do NOT provide both category and subagent_type."
  if (!availableSubagentNames?.length) return tool.schema.string().optional().describe(describe)
  const subagentNames = [...new Set([...availableSubagentNames, ...aliases])].filter(
    (name) => !isPlanAgent(name) && !isDirectSubagentTypeDisabled(name),
  )
  const schemaSubagentNames =
    subagentNames.length > 0
      ? subagentNames
      : BUILTIN_SUBAGENT_TYPES.map((subagent) => subagent.name).filter(
          (name) => !isPlanAgent(name) && !isDirectSubagentTypeDisabled(name),
        )
  return tool.schema.enum(schemaSubagentNames).optional().describe(describe)
}

export function buildDelegateTaskArgsSchema(
  availableSubagentNames?: readonly string[],
  aliases: readonly string[] = [],
): {
  load_skills: OptionalStringArraySchema
  description: OptionalStringSchema
  prompt: StringSchema
  run_in_background: OptionalBooleanSchema
  category: OptionalStringSchema
  model_routing: OptionalBooleanSchema
  subagent_type: OptionalStringSchema | OptionalEnumSchema
  reasoning: OptionalStringSchema
  task_id: OptionalStringSchema
  command: OptionalStringSchema
} {
  return {
    load_skills: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Optional skill names. Omit for best-effort suggestions when Jev routing is active. Pass [] for none, or explicit names to use those names unchanged. Mandatory skill workflows still apply.",
      ),
    description: tool.schema
      .string()
      .optional()
      .describe("Short task description (3-5 words). Auto-generated from prompt if omitted."),
    prompt: tool.schema
      .string()
      .describe(
        "Concrete goal, acceptance criteria, allowed scope, sourced hard limits, and relevant context labeled verified, assumed, or unknown. Capable workers own the method; add steps only when required by the contract or a mechanical/limited-worker assignment. Use normal prose and spaces; preserve exact identifiers.",
      ),
    run_in_background: tool.schema
      .boolean()
      .optional()
      .describe(
        "true is the standard spawn: returns a background task ID `bg_...` at once; inspect the result/error delivered in the native completion notification. background_output is optional for missing/truncated output or transcript/diagnostic detail. false blocks this response until the child finishes; use it only for a short child whose result gates your very next call. Omitted counts as false.",
      ),
    category: tool.schema
      .string()
      .optional()
      .describe(
        "Default: auto when Jev routing is enabled; omission selects auto unless subagent_type or task_id is supplied. Explicit categories remain available and are observed without changing dispatch. With Jev mode off, category or subagent_type is required.",
      ),
    model_routing: tool.schema
      .boolean()
      .optional()
      .describe(
        "Set false to bypass optional Jev routing for category auto or an agent ladder; omitted uses the configured mode. Does not affect team members, explicit categories or real named agents.",
      ),
    subagent_type: buildSubagentTypeSchema(availableSubagentNames, aliases),
    reasoning: tool.schema
      .string()
      .optional()
      .describe(
        "Optional reasoning override only with subagent_type (including a Jev alias). Canonical levels: off, auto, minimal, low, medium, high, xhigh, max. Unknown names pass through as provider variants, matching permissive agent config. Overrides agent configuration; category delegation ignores this argument.",
      ),
    task_id: tool.schema
      .string()
      .optional()
      .describe("Continuation session id (`ses_...`) from task metadata; not a background task id (`bg_...`)."),
    command: tool.schema.string().optional().describe("The command that triggered this task"),
  }
}

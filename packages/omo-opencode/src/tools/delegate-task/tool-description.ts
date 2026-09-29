import type { AvailableCategory, AvailableSkill } from "../../agents/dynamic-agent-prompt-builder"
import { mergeCategories } from "../../shared/merge-categories"
import { CATEGORY_CALLER_GUIDANCE } from "./builtin-categories"
import { formatAvailableAgentTypesSection } from "./builtin-subagent-types"
import { CATEGORY_DESCRIPTIONS } from "./constants"
import { getJevRoutingEligibility } from "./jev-routing"
import type { DelegateTaskToolOptions } from "./types"

export interface DelegateTaskPresentation {
  availableCategories: AvailableCategory[]
  availableSkills: AvailableSkill[]
  categoryExamples: string
  description: string
}

type DelegateTaskPresentationOptions = Pick<
  DelegateTaskToolOptions,
  "availableCategories" | "availableSkills" | "userCategories" | "jevRouting" | "availableSubagentNames" | "descriptionAgentNames" | "disabledAgents" | "agentOverrides"
>

export function createDelegateTaskPresentation(options: DelegateTaskPresentationOptions): DelegateTaskPresentation {
  const { userCategories } = options
  const allCategories = mergeCategories(userCategories)
  const routing = options.jevRouting
  const showTierRouting = routing && routing.mode !== "off"
    && getJevRoutingEligibility({ config: routing, categories: userCategories, enabledCategories: allCategories }).valid
  const agentNames = new Set(options.descriptionAgentNames ?? options.availableSubagentNames ?? [])
  const visibleAgent = (name: string) => agentNames.has(name)
    && !options.disabledAgents?.includes(name)
    && !(Object.hasOwn(options.agentOverrides ?? {}, name) && options.agentOverrides?.[name]?.disable)
  const visibleAliases = routing?.mode !== "off" && (options.descriptionAgentNames || options.availableSubagentNames)
    ? Object.entries(routing?.agent_ladders ?? {}).filter(([alias, value]) =>
      !["__proto__", "constructor", "prototype"].includes(alias)
      && !agentNames.has(alias) && !Object.hasOwn(allCategories, alias)
      && value.ladder.length >= 2 && value.ladder.length <= 8
      && new Set(value.ladder).size === value.ladder.length
      && visibleAgent(value.default) && value.ladder.every(visibleAgent))
    : []
  const categoryEntries = Object.entries(allCategories).map(([name, categoryConfig]) => ({
    name,
    categoryConfig,
    description: userCategories?.[name]?.description || CATEGORY_DESCRIPTIONS[name],
    callerGuidance: CATEGORY_CALLER_GUIDANCE[name],
  }))
  if (showTierRouting) {
    categoryEntries.sort((a, b) => Number(b.name === "auto") - Number(a.name === "auto"))
  }
  const categoryNames = categoryEntries.map(({ name }) => name)
  const categoryExamples = categoryNames.join(", ")

  const availableCategories: AvailableCategory[] = options.availableCategories
    ?? categoryEntries.map(({ name, categoryConfig, description }) => {
      return {
        name,
        description: description || "General tasks",
        model: categoryConfig.model,
      }
    })

  const availableSkills: AvailableSkill[] = options.availableSkills ?? []

  const categoryList = categoryEntries.map(({ name, description, callerGuidance }) => {
    const categoryLine = description ? `  - ${name}: ${description}` : `  - ${name}`
    const indentedGuidance = callerGuidance?.replaceAll("\n", "\n    ")
    return indentedGuidance ? `${categoryLine}\n    ${indentedGuidance}` : categoryLine
  }).join("\n")

  const description = `Spawn agent task with category-based or direct agent selection.
${showTierRouting ? `TIER ROUTING: if the right tier is unclear, use task(category="auto"); Jev picks the cheapest suitable tier (${routing.ladder?.map((tier) => JSON.stringify(tier)).join(" → ")}) and falls back to ${JSON.stringify(routing.default)}.` : ""}

  ⚠️  CRITICAL: You MUST provide EITHER category OR subagent_type. Omitting BOTH will FAIL.

  **COMMON MISTAKE (DO NOT DO THIS):**
  \`\`\`
  task(description="...", prompt="...")  // ❌ FAILS - missing category AND subagent_type
  \`\`\`

  **CORRECT - Using category:**
  \`\`\`
  task(category="quick", description="Fix type error", prompt="...")
  \`\`\`

  **CORRECT - Using subagent_type with parallel exploration:**
  \`\`\`
  task(subagent_type="explore", description="Find patterns", prompt="...", run_in_background=true)
  \`\`\`

  REQUIRED: Provide ONE of:
  - category: For task delegation (uses Sisyphus-Junior with category-optimized model)
  - subagent_type: For direct agent invocation (explore, librarian, oracle, etc.)

  **DO NOT provide both.** If category is provided, subagent_type is ignored.

  - load_skills: Optional. Defaults to [] when omitted. Pass ["skill-1", "skill-2"] for skill-specific tasks.
  - category: Use predefined category → Spawns Sisyphus-Junior with category config
    Available categories:
  ${categoryList}
  - subagent_type: Use specific agent directly (explore, librarian, oracle, metis, momus)
  - run_in_background: true is the standard spawn: returns a background task ID like \`bg_...\` at once and the completion notification delivers the result. false blocks this response until the child finishes (a 30-minute inactivity window, reset by OpenCode busy/retry/running status, not a total wall-clock limit); use it only for a short child whose result gates your very next call. Omitted counts as false.
  - task_id: Continuation session id (\`ses_...\`) from task metadata. Continues the same subagent session with FULL CONTEXT PRESERVED; not the background task id (\`bg_...\`).
  - command: The command that triggered this task (optional, for slash command tracking).

  **WHEN TO USE task_id:**
  - Task failed/incomplete → \`task(task_id="ses_...", prompt="fix: [specific issue]")\`
  - Need follow-up on previous result → \`task(task_id="ses_...", prompt="Also: [question]")\`
  - Multi-turn conversation with same agent → always \`task(task_id="ses_...")\` instead of new task

  Prompts MUST be in English.

${formatAvailableAgentTypesSection()}
${visibleAliases.map(([alias, value]) => `  - ${JSON.stringify(alias)}: Jev picks among ${value.ladder.map((name) => JSON.stringify(name)).join(" → ")} (default ${JSON.stringify(value.default)})`).join("\n")}`

  return {
    availableCategories,
    availableSkills,
    categoryExamples,
    description,
  }
}

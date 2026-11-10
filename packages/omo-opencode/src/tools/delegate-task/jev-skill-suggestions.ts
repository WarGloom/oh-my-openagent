import type { JevRoutingConfig } from "../../config/schema"
import { isDisabledSkillAlias } from "../../features/opencode-skill-loader/skill-discovery"
import { capJevText, sanitizeJevText } from "./jev-router-state"
import { selectSkillsWithJev } from "./jev-routing"

export async function suggestDelegateSkills(input: {
  readonly description: string
  readonly skills: readonly { readonly name: string; readonly description: string }[]
  readonly disabledSkills?: ReadonlySet<string>
  readonly config?: JevRoutingConfig
  readonly modelRouting?: false
  readonly signal?: AbortSignal
}): Promise<string[]> {
  if (input.config?.mode !== "active" || input.modelRouting === false) return []
  const disabled = new Set([...(input.disabledSkills ?? [])].map((name) => name.toLowerCase()))
  const seen = new Set<string>()
  const eligible = input.skills.filter((skill) => {
    const name = skill.name.toLowerCase()
    if (
      seen.has(name) ||
      isDisabledSkillAlias({ name, scope: "config", definition: { name, description: "", template: "" } }, disabled)
    )
      return false
    seen.add(name)
    return true
  })
  const candidates = eligible.map(({ name, description }, index) => ({
    name: `${capJevText(sanitizeJevText(name), 100)} #${index}`,
    description: capJevText(sanitizeJevText(description), 200),
  }))
  if (candidates.length === 0) return []
  const selected = await selectSkillsWithJev({
    brief: capJevText(sanitizeJevText(input.description), 200),
    config: input.config,
    candidates,
    modelRouting: input.modelRouting,
    signal: input.signal,
  })
  const selectedNames = new Set(selected)
  return eligible.filter((_, index) => selectedNames.has(candidates[index]?.name ?? "")).map((skill) => skill.name)
}

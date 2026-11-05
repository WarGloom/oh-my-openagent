import { getEffectiveModel } from "../../cli/doctor/checks/model-resolution-effective-model"
import type { OhMyOpenCodeConfig } from "../../config"
import { validatePluginConfig } from "../../config/validate"
import { migrateDisabledAgents } from "../../shared/disabled-agents"
import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS } from "../../shared/model-requirements"
import type { RosterRow } from "./state-types"

type ResolutionEntry = {
  readonly name: string
  readonly effectiveModel: string
}

function formatModelLabel(model: string): string {
  const slashIndex = model.lastIndexOf("/")
  if (slashIndex < 0 || slashIndex === model.length - 1) {
    return model
  }
  return model.slice(slashIndex + 1)
}

function toRosterRow(entry: ResolutionEntry): RosterRow {
  return {
    label: entry.name,
    model: formatModelLabel(entry.effectiveModel),
  }
}

export function resolveRoster(directory: string, config?: OhMyOpenCodeConfig): RosterRow[] {
  try {
    const resolvedConfig = config ?? validatePluginConfig(directory).config
    const disabledAgents = new Set(
      migrateDisabledAgents(resolvedConfig.disabled_agents).map((agent) => agent.toLowerCase()),
    )
    return [
      ...Object.entries(AGENT_MODEL_REQUIREMENTS)
        .filter(([name]) => !disabledAgents.has(name.toLowerCase()))
        .map(([name, requirement]) => ({
          name,
          effectiveModel: getEffectiveModel(requirement, resolvedConfig.agents?.[name]?.model),
        })),
      ...Object.entries(CATEGORY_MODEL_REQUIREMENTS).map(([name, requirement]) => ({
        name,
        effectiveModel: getEffectiveModel(requirement, resolvedConfig.categories?.[name]?.model),
      })),
    ]
      .map(toRosterRow)
      .sort((left, right) => left.label.localeCompare(right.label))
  } catch (error) {
    if (error instanceof Error) {
      return []
    }
    throw error
  }
}

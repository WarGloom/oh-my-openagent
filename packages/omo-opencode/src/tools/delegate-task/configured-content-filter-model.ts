import type { AgentOverrides } from "../../config/schema"
import { parseModelString } from "../../shared/model-string-parser"
import type { DelegatedModelConfig } from "./types"

export function configuredContentFilterModel(
  required: string | undefined,
  agents: AgentOverrides | undefined,
): DelegatedModelConfig | undefined {
  if (!required) return undefined
  for (const name of ["daybreak", "mythos"] as const) {
    for (const entry of agents?.[name]?.models ?? []) {
      const model = typeof entry === "string" ? entry : entry.model
      const parsed = parseModelString(model)
      if (!parsed || `${parsed.providerID}/${parsed.modelID}` !== required) continue
      return {
        providerID: parsed.providerID,
        modelID: parsed.modelID,
        ...((typeof entry === "string" ? parsed.variant : (entry.variant ?? parsed.variant))
          ? { variant: typeof entry === "string" ? parsed.variant : (entry.variant ?? parsed.variant) }
          : {}),
        ...(typeof entry === "string"
          ? {}
          : {
              ...((entry.reasoning ?? entry.variant) ? { reasoning: entry.reasoning ?? entry.variant } : {}),
              ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
            }),
      }
    }
  }
  return undefined
}

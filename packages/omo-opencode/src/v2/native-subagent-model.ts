import type { Hooks } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { lowerReasoningForModel } from "../shared/agent-variant"
import { parseModelString } from "../shared/model-string-parser"
import { transformModelForProvider } from "../shared/provider-model-id-transform"
import type { V2PluginContext, V2Registration } from "./context-types"

const agentModelOverrides = new WeakMap<Hooks, NonNullable<OhMyOpenCodeConfig["agents"]>>()

export function bindAgentModelOverrides(hooks: Hooks, agents: OhMyOpenCodeConfig["agents"]): void {
  if (agents) agentModelOverrides.set(hooks, agents)
}

export async function installNativeSubagentModel(
  context: V2PluginContext,
  hooks: Hooks,
): Promise<V2Registration | undefined> {
  const overrides = agentModelOverrides.get(hooks)
  if (!overrides) return undefined
  // The host's markdown-agent transform runs after external plugins; override new dispatches instead.
  return context.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return
    const input = event.input
    if (typeof input !== "object" || input === null || Array.isArray(input)) return
    if ("model" in input || "sessionID" in input || !("agent" in input) || typeof input.agent !== "string") return
    const agentKey = getAgentConfigKey(input.agent)
    const override = Object.entries(overrides).find(([id]) => getAgentConfigKey(id) === agentKey)?.[1]
    const parsed = override?.model ? parseModelString(override.model) : undefined
    if (!parsed) return
    const modelID = transformModelForProvider(parsed.providerID, parsed.modelID)
    const lowered = lowerReasoningForModel(
      override?.reasoning ?? override?.variant ?? parsed.variant ?? override?.reasoningEffort,
      { providerID: parsed.providerID, modelID },
    )
    const candidate = lowered.variant ?? lowered.reasoningEffort
    const models = (await context.model.list()).data
    const model = models.find((entry) => entry.providerID === parsed.providerID && entry.modelID === modelID)
    const variant = model?.variants.find((entry) => entry.id === candidate)?.id
    event.input = { ...input, model: `${parsed.providerID}/${modelID}${variant === undefined ? "" : `#${variant}`}` }
  })
}

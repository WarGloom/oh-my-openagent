import { noteNativeDecision } from "./native-rework-ledger"
import type { Hooks } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { lowerReasoningForModel } from "../shared/agent-variant"
import { parseModelString } from "../shared/model-string-parser"
import { transformModelForProvider } from "../shared/provider-model-id-transform"
import { buildFallbackChainFromModels } from "../shared/fallback-chain-from-models"
import { registerDelegatedChildSessionBootstrap } from "../shared/delegated-child-session-bootstrap"
import {
  recordJevRouting,
  recordNamedRoutingSkip,
  type NamedSkipReason,
} from "../tools/delegate-task/jev-routing-ledger"
import { configuredAgentModelChain, planNamedAgentModels } from "../tools/delegate-task/named-agent-model-plan"
import type { V2PluginContext, V2Registration } from "./context-types"

const agentModelOverrides = new WeakMap<Hooks, NonNullable<OhMyOpenCodeConfig["agents"]>>()

const routingConfigs = new WeakMap<Hooks, NonNullable<OhMyOpenCodeConfig["jev_routing"]>>()

export function bindAgentModelOverrides(
  hooks: Hooks,
  agents: OhMyOpenCodeConfig["agents"],
  routing?: OhMyOpenCodeConfig["jev_routing"],
): void {
  if (routing) routingConfigs.set(hooks, routing)
  if (agents) agentModelOverrides.set(hooks, agents)
}

export async function installNativeSubagentModel(
  context: V2PluginContext,
  hooks: Hooks,
): Promise<V2Registration | undefined> {
  // The host's markdown-agent transform runs after external plugins; override new dispatches instead.
  const routing = routingConfigs.get(hooks)
  const maxPendingAdmissions = 256
  const pendingAdmissionLifetimeMs = 30 * 60 * 1000
  const pending = new Map<
    string,
    {
      readonly selected: string
      readonly expiresAt: number
      readonly fallbacks: ReturnType<typeof buildFallbackChainFromModels>
    }
  >()
  const callKey = (sessionID: string, messageID: string, callID: string) =>
    JSON.stringify([sessionID, messageID, callID])
  const before = await context.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return
    const input = event.input
    if (typeof input !== "object" || input === null || Array.isArray(input)) return
    if (!("agent" in input) || typeof input.agent !== "string" || !input.agent.trim()) return
    const agentKey = getAgentConfigKey(input.agent)
    const skip = (reason: NamedSkipReason) =>
      recordNamedRoutingSkip({ agent: agentKey, surface: "subagent", parentSessionID: event.sessionID, reason })
    if ("sessionID" in input || "model" in input) {
      await skip("sessionID" in input ? "continuation" : "explicit_model")
      return
    }
    const override = Object.entries(agentModelOverrides.get(hooks) ?? {}).find(
      ([id]) => getAgentConfigKey(id) === agentKey,
    )?.[1]
    const declarations = routing?.named_agent_tiers
    const declared = declarations && Object.hasOwn(declarations, agentKey)
    const reason =
      "model_routing" in input && input.model_routing === false
        ? "opt_out"
        : !declared
          ? "no_opt_in"
          : !context.session.supportsNativeSubagentAdmission || override?.models_distribution === "round_robin"
            ? "pinned_by_rule"
            : !override?.model && !override?.models?.length
              ? "no_available_pair"
              : undefined
    if (reason) await skip(reason)
    if (!override?.model && !override?.models?.length) return
    const models = (await context.model.list()).data
    if (pending.size >= maxPendingAdmissions) {
      const now = Date.now()
      for (const [key, pendingPlan] of pending) if (pendingPlan.expiresAt <= now) pending.delete(key)
    }
    const plan =
      !reason &&
      routing &&
      context.session.supportsNativeSubagentAdmission &&
      pending.size < maxPendingAdmissions &&
      "prompt" in input &&
      typeof input.prompt === "string" &&
      !("model_routing" in input && input.model_routing === false) &&
      override?.models_distribution !== "round_robin"
        ? await planNamedAgentModels({
            agent: agentKey,
            config: routing,
            brief: input.prompt,
            parentSessionID: event.sessionID,
            surface: "subagent",
            chain: configuredAgentModelChain(override),
            available: new Set(models.map((model) => model.providerID + "/" + model.modelID)),
          })
        : undefined
    if (
      !reason &&
      !plan &&
      (pending.size >= maxPendingAdmissions || !("prompt" in input) || typeof input.prompt !== "string")
    )
      await skip("pinned_by_rule")
    if (plan) {
      noteNativeDecision(context, event.sessionID, event.id, plan.decision.decision_id)
      await recordJevRouting(plan.decision)
    }
    const head = plan?.models[0]
    const primary = typeof head === "string" ? head : (head?.model ?? override?.model)
    const parsed = primary ? parseModelString(primary) : undefined
    if (!parsed) return
    const modelID = transformModelForProvider(parsed.providerID, parsed.modelID)
    const lowered = lowerReasoningForModel(
      plan
        ? typeof head === "object"
          ? (head.reasoning ?? head.variant ?? parsed.variant ?? head.reasoningEffort)
          : parsed.variant
        : (override?.reasoning ?? override?.variant ?? parsed.variant ?? override?.reasoningEffort),
      { providerID: parsed.providerID, modelID },
    )
    const candidate = lowered.variant ?? lowered.reasoningEffort
    const model = models.find((entry) => entry.providerID === parsed.providerID && entry.modelID === modelID)
    const variant = model?.variants.find((entry) => entry.id === candidate)?.id
    event.input = { ...input, model: `${parsed.providerID}/${modelID}${variant === undefined ? "" : `#${variant}`}` }
    if (plan && model) {
      const key = callKey(event.sessionID, event.messageID, event.id)
      pending.set(key, {
        selected: parsed.providerID + "/" + modelID,
        expiresAt: Date.now() + pendingAdmissionLifetimeMs,
        fallbacks: buildFallbackChainFromModels(plan.models.slice(1), parsed.providerID),
      })
    }
  })
  if (!routing?.named_agent_tiers || !context.session.supportsNativeSubagentAdmission) return before
  const admitted = await context.session.hook("experimental.subagent.admitted", (event) => {
    const key = callKey(event.parentSessionID, event.messageID, event.toolCallID)
    const plan = pending.get(key)
    pending.delete(key)
    if (!plan || !event.model || plan.selected !== event.model.providerID + "/" + event.model.id) return
    registerDelegatedChildSessionBootstrap({
      sessionID: event.childSessionID,
      promptText: "",
      fallbackChain: plan.fallbacks,
      namedModelPlan: true,
    })
  })
  const after = await context.tool.hook("execute.after", (event) => {
    if (event.tool === "subagent") pending.delete(callKey(event.sessionID, event.messageID, event.id))
  })
  return {
    dispose: async () => {
      pending.clear()
      await after.dispose()
      await admitted.dispose()
      await before.dispose()
    },
  }
}

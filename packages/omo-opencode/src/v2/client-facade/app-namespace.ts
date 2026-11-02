import type { V2AgentInfo, V2PermissionRule, V2PluginContext } from "../context-types"

/** 2.x action names back to the 1.x permission keys that `normalizeAction` (config-bridge) renamed. */
const V1_PERMISSION_BY_ACTION: ReadonlyMap<string, string> = new Map([
  ["subagent", "task"],
  ["shell", "bash"],
])

/** 2.x rules in 1.x `{ permission, pattern, action }` form, order kept so the last matching rule still wins. */
function toV1PermissionRules(rules: ReadonlyArray<V2PermissionRule>): Array<Record<string, string>> {
  return rules.map((rule) => ({
    permission: V1_PERMISSION_BY_ACTION.get(rule.action) ?? rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
}

function toV1Agent(agent: V2AgentInfo): Record<string, unknown> {
  return {
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    builtIn: false,
    native: false,
    hidden: agent.hidden,
    color: agent.color,
    steps: agent.steps,
    model: agent.model === undefined ? undefined : { providerID: agent.model.providerID, modelID: agent.model.id },
    variant: agent.model?.variant,
    permission: toV1PermissionRules(agent.permissions),
    options: {},
  }
}

/** `app.agents()` in the 1.x shape `{ data: Agent[] }`, built from the host's agent list. */
export function createAppNamespace(context: V2PluginContext) {
  return {
    agents: async () => ({ data: (await context.agent.list()).data.map(toV1Agent) }),
  }
}

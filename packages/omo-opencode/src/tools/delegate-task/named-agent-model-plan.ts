import { createHash, randomUUID } from "node:crypto"
import type { JevRoutingConfig } from "../../config/schema"
import type { FallbackModelObject } from "../../config/schema/fallback-models"
import { parseModelString } from "../../shared/model-string-parser"
import { briefTier, judgeNamedAgentBrief } from "./named-agent-brief-judgments"
import { recordNamedRoutingSkip, type NamedSkipReason, type JevDecisionRecord } from "./jev-routing-ledger"

import type { AgentOverrides } from "../../config/schema"
import { normalizeFallbackModels } from "../../shared/model-resolver"

type Entry = string | FallbackModelObject

export type NamedAgentModelRequest = {
  readonly brief: string
  readonly parentSessionID?: string
  readonly signal?: AbortSignal
  readonly surface?: "task" | "subagent"
}

export function configuredAgentModelChain(override: AgentOverrides[string]): readonly Entry[] {
  if (override?.models) return override.models
  return override?.model
    ? [
        { model: override.model, reasoning: override.reasoning ?? override.variant ?? override.reasoningEffort },
        ...(normalizeFallbackModels(override.fallback_models) ?? []),
      ]
    : []
}

export function namedModelID(entry: Entry): string | undefined {
  const parsed = parseModelString(typeof entry === "string" ? entry : entry.model)
  return parsed && `${parsed.providerID}/${parsed.modelID}`
}

export async function planNamedAgentModels(
  input: NamedAgentModelRequest & {
    readonly agent: string
    readonly config: JevRoutingConfig | undefined
    readonly chain: readonly Entry[]
    readonly available: ReadonlySet<string>
    readonly unavailable?: ReadonlySet<string>
  },
): Promise<{ readonly models: readonly Entry[]; readonly decision: JevDecisionRecord } | undefined> {
  const { agent, config, chain, available, unavailable, brief } = input
  const declarations = config?.named_agent_tiers
  const declaration = declarations && Object.hasOwn(declarations, agent) ? declarations[agent] : undefined
  const skip = (reason: NamedSkipReason) =>
    recordNamedRoutingSkip({ agent, surface: input.surface ?? "task", parentSessionID: input.parentSessionID, reason })
  if (!config || !declaration || config.mode === "off") {
    await skip(declaration ? "pinned_by_rule" : "no_opt_in")
    return undefined
  }
  const entries = new Map(
    chain.flatMap((entry) => {
      const id = namedModelID(entry)
      return id ? [[id, entry] as const] : []
    }),
  )
  const isAvailable = (id: string) => available.has(id) && !unavailable?.has(id)
  const primary = chain[0] === undefined ? undefined : namedModelID(chain[0])
  const fallback = [...entries.keys()].find(isAvailable) ?? primary
  if (!fallback) {
    await skip("no_available_pair")
    return undefined
  }
  const valid = entries.has(declaration.lighter) && entries.has(declaration.stronger)
  const result =
    valid && isAvailable(declaration.lighter) && isAvailable(declaration.stronger)
      ? await judgeNamedAgentBrief({ role: declaration.role, brief, config, signal: input.signal })
      : undefined
  const selected =
    result?.kind === "answer" && config.mode === "active" ? declaration[briefTier(result.scores)] : fallback
  const chosen = entries.get(selected)
  const models = chosen ? [chosen, ...chain.filter((entry) => namedModelID(entry) !== selected)] : chain
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  const error = !valid ? "invalid_config" : result?.kind === "error" ? result.error : null
  const skipReason = !result
    ? "no_available_pair"
    : result.kind === "error"
      ? result.error === "oversized_request"
        ? "oversized_request"
        : "router_failure"
      : config.mode !== "active"
        ? "pinned_by_rule"
        : undefined
  const decision: JevDecisionRecord = {
    schema_version: 1,
    event_id: randomUUID(),
    decision_id: randomUUID(),
    event: "decision",
    timestamp: new Date().toISOString(),
    parent_session_id: input.parentSessionID ?? null,
    parent_decision_id: null,
    surface: input.surface ?? "task",
    mode: config.mode,
    orchestrator_category: "named-agent",
    chosen_category: null,
    named_model: {
      agent,
      selected_model: selected,
      action: result?.kind === "answer" && config.mode === "active" ? "automatic" : "default",
      skip_reason: skipReason,
      request_payload: result?.requestPayload,
      fallback_plan: models.slice(1).flatMap((entry) => namedModelID(entry) ?? []),
    },
    top1: null,
    top2: null,
    answers: result?.kind === "answer" ? result.scores : null,
    artifact_id: null,
    jev_model_id: result?.kind === "answer" ? result.model : null,
    latency_ms: result?.latencyMs ?? 0,
    input_tokens: null,
    backend: result?.backend ?? (process.env[config.api_key_env] ? "typesafe" : "zen"),
    error,
    brief_status: "none",
    would_block: false,
    reason_codes: [],
    config_generation: hash(JSON.stringify([agent, declaration, chain])),
    brief_sha256: hash(brief),
    brief_bytes: Buffer.byteLength(brief),
  }
  return { models, decision }
}

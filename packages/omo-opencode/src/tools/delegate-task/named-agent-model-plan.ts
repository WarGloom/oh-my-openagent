import { createHash, randomUUID } from "node:crypto"
import type { JevRoutingConfig } from "../../config/schema"
import type { FallbackModelObject } from "../../config/schema/fallback-models"
import { parseModelString } from "../../shared/model-string-parser"
import { selectCandidateWithJev, type SuitabilityDecision } from "./jev-routing"
import type { JevDecisionRecord } from "./jev-routing-ledger"

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
  const declarations = config?.named_agent_models
  if (!config || config.mode === "off" || !declarations || !Object.hasOwn(declarations, agent)) return undefined
  const declaration = declarations[agent]
  if (!declaration) return undefined
  const entries = new Map(
    chain.flatMap((entry) => {
      const id = namedModelID(entry)
      return id ? [[id, entry] as const] : []
    }),
  )
  const isAvailable = (id: string) => available.has(id) && !unavailable?.has(id)
  const primary = chain[0] === undefined ? undefined : namedModelID(chain[0])
  const fallback = [...entries.keys()].find(isAvailable) ?? primary
  if (!fallback) return undefined
  const valid = declaration.candidates.every((id) => entries.has(id))
  const candidates = valid ? declaration.candidates.filter(isAvailable) : []
  let result: SuitabilityDecision | undefined
  const selected =
    candidates.length > 1
      ? await selectCandidateWithJev({
          config,
          kind: "model",
          brief,
          fallback,
          signal: input.signal,
          candidates: candidates.map((name) => ({
            name,
            description:
              declaration.suitability?.[name] ??
              "Configured for this agent; assess fit for this task's scope and reasoning demands.",
          })),
          onDecision: (decision) => {
            result = decision
          },
        })
      : fallback
  const chosen = entries.get(selected)
  const models = chosen ? [chosen, ...chain.filter((entry) => namedModelID(entry) !== selected)] : chain
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  const status = result?.status
  const error = !valid
    ? "invalid_config"
    : status === "oversized_request" || status === "http_error" || status === "malformed" || status === "unavailable"
      ? status
      : null
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
      action: status === "selected" ? "automatic" : "default",
      fallback_plan: models.slice(1).flatMap((entry) => namedModelID(entry) ?? []),
    },
    top1: null,
    top2: null,
    answers: result?.scores ?? null,
    artifact_id: null,
    jev_model_id: result?.routerModel ?? null,
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

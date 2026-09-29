import { z } from "zod"
import type { AgentOverrides, CategoriesConfig, JevRoutingConfig } from "../../config/schema"
import { log } from "../../shared/logger"
import { CATEGORY_DESCRIPTIONS } from "./constants"
import { mergeCategories } from "../../shared/merge-categories"
import { normalizeSDKResponse } from "../../shared"
import { findCallableAgentMatch, mergeWithClaudeCodeAgents, type AgentInfo } from "./subagent-discovery"
import type { OpencodeClient } from "./types"
import { getAgentConfigKey } from "../../shared/agent-display-names"

const JEV_URL = "https://opencode.ai/zen/v1/systemone"
const JEV_MODEL = "jev-1.13-free"
const MAX_BRIEF_BYTES = 8192
const MAX_REQUEST_BYTES = 16384
const MAX_RESPONSE_BYTES = 65536

const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  })),
})

export type JevRoutingInput = {
  readonly brief: string
  readonly config: JevRoutingConfig | undefined
  readonly categories: CategoriesConfig | undefined
  readonly enabledCategories: Readonly<Record<string, { description?: string }>>
  readonly modelRouting?: false
  readonly signal?: AbortSignal
}

type Candidate = { readonly name: string; readonly description: string }
type SelectorInput = {
  readonly brief: string
  readonly config: JevRoutingConfig
  readonly candidates: readonly Candidate[]
  readonly fallback: string
  readonly modelRouting?: false
  readonly signal?: AbortSignal
  readonly kind: "tier" | "agent"
}

export type AgentLadderContext = {
  readonly config?: JevRoutingConfig
  readonly client: OpencodeClient
  readonly directory: string
  readonly categories?: CategoriesConfig
  readonly modelRouting?: false
  readonly signal?: AbortSignal
  readonly disabledAgents?: readonly string[]
  readonly agentOverrides?: AgentOverrides
}

function dispatchable(agents: AgentInfo[], name: string): AgentInfo | undefined {
  if (name === "__proto__" || name === "constructor" || name === "prototype") return undefined
  return findCallableAgentMatch(agents, name)
}

export async function getAgentLadder(alias: string, context: AgentLadderContext) {
  const definitions = context.config?.agent_ladders
  if (!definitions || !Object.hasOwn(definitions, alias)) return undefined
  const ladder = definitions[alias]
  const agentsResult = await context.client.app.agents()
  const agents = mergeWithClaudeCodeAgents(
    normalizeSDKResponse(agentsResult, [] as AgentInfo[], { preferResponseOnMissingData: true }),
    context.directory,
  )
  const enabledCategories = mergeCategories(context.categories)
  const collidesAgent = agents.some((agent) => agent.name === alias || dispatchable(agents, alias) === agent)
  const validName = (name: string) => !context.disabledAgents?.includes(name)
    && !(Object.hasOwn(context.agentOverrides ?? {}, getAgentConfigKey(name))
      && context.agentOverrides?.[getAgentConfigKey(name)]?.disable === true)
    && dispatchable(agents, name) !== undefined
  const validDefault = validName(ladder.default)
  const valid = alias !== "__proto__" && alias !== "constructor" && alias !== "prototype"
    && !collidesAgent
    && !Object.hasOwn(enabledCategories, alias)
    && ladder.ladder.length >= 2 && ladder.ladder.length <= 8
    && new Set(ladder.ladder).size === ladder.ladder.length
    && ladder.ladder.every(validName) && validDefault
  return { ladder, agents, valid, validDefault, collidesAgent }
}

export async function selectAgentWithJev(
  alias: string,
  brief: string,
  context: AgentLadderContext,
): Promise<string | undefined> {
  context.signal?.throwIfAborted()
  const eligibility = await getAgentLadder(alias, context)
  if (!eligibility) return undefined
  const { ladder, agents, valid, validDefault, collidesAgent } = eligibility
  if (collidesAgent) {
    log("[jev-routing] agent decision", { status: "alias_collision", alias })
    return alias
  }
  if (!valid) {
    log("[jev-routing] agent decision", { status: "invalid_config", alias, candidates: ladder.ladder })
    return validDefault ? ladder.default : undefined
  }
  return selectCandidateWithJev({
    brief, config: context.config as JevRoutingConfig, fallback: ladder.default, kind: "agent",
    modelRouting: context.modelRouting, signal: context.signal,
    candidates: ladder.ladder.map((name) => ({
      name,
      description: (Object.hasOwn(ladder.suitability ?? {}, name) ? ladder.suitability?.[name] : undefined)
        ?? (Object.hasOwn(context.agentOverrides ?? {}, getAgentConfigKey(name))
          ? context.agentOverrides?.[getAgentConfigKey(name)]?.description : undefined)
        ?? dispatchable(agents, name)?.description ?? "",
    })),
  })
}

export function getJevRoutingEligibility({ config, categories, enabledCategories }: Pick<JevRoutingInput, "config" | "categories" | "enabledCategories">) {
  const ladder = config?.ladder ?? []
  const fallback = config?.default
  const validTier = (name: string) => name !== "auto" && Object.hasOwn(enabledCategories, name)
    && enabledCategories[name] !== undefined
  const validDefault = fallback !== undefined && validTier(fallback)
  const valid = Boolean(
    categories?.auto && !categories.auto.disable
    && Object.keys(categories.auto).every((key) => key === "description")
    && categories.auto.description?.trim()
    && validDefault && ladder.length >= 2 && ladder.length <= 8
    && new Set(ladder).size === ladder.length && ladder.every(validTier),
  )
  return { valid, validDefault }
}

export async function selectCategoryTierWithJev(input: JevRoutingInput): Promise<string | undefined> {
  const { brief, config, categories, enabledCategories, modelRouting, signal } = input
  signal?.throwIfAborted()
  const ladder = config?.ladder ?? []
  const fallback = config?.default
  const { valid, validDefault } = getJevRoutingEligibility({ config, categories, enabledCategories })
  if (!valid || !config || !fallback) {
    log("[jev-routing] tier decision", { status: "invalid_config", candidates: ladder, scores: {}, chosenCategory: fallback })
    return validDefault ? fallback : undefined
  }
  return selectCandidateWithJev({
    brief, config, fallback, kind: "tier", modelRouting, signal,
    candidates: ladder.map((name) => ({ name, description: categories?.[name]?.description || CATEGORY_DESCRIPTIONS[name] || "" })),
  })
}

export async function selectCandidateWithJev(input: SelectorInput): Promise<string> {
  const { brief, config, fallback, candidates, modelRouting, signal, kind } = input
  signal?.throwIfAborted()
  const started = performance.now()
  const ladder = candidates.map((candidate) => candidate.name)
  let status = "disabled"
  let scores: Record<string, number> = {}
  let choice: string = fallback
  try {
    if (config.mode === "off" || modelRouting === false) return fallback
    if (new TextEncoder().encode(brief).length > MAX_BRIEF_BYTES) {
      status = "oversized_brief"
      return fallback
    }
    const questions = Object.fromEntries(candidates.map(({ name: tier, description }, index) => {
      const label = kind === "tier" ? "tier" : "agent"
      return [
        `tier_${index}`,
        {
          type: "noul",
          instructions: `Score whether ${label} ${tier} is suitable for the current delegation brief. ${kind === "tier" ? "Category" : "Agent"} description: ${description}. Score suitability only, not price or model capability claims.`,
          criteria: {
            true: `The delegation brief is suitable for ${label} ${tier}: ${description}`,
            false: `The delegation brief is not suitable for ${label} ${tier}.`,
          },
        },
      ]
    }))
    const body = JSON.stringify({ model: JEV_MODEL, state: brief, questions })
    if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
      status = "oversized_request"
      return fallback
    }
    const timeout = AbortSignal.timeout(config.timeout_ms)
    const response = await fetch(JEV_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      status = "http_error"
      return fallback
    }
    const contentLength = response.headers.get("content-length")
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      status = "malformed"
      void response.body?.cancel().catch(() => undefined)
      return fallback
    }
    const reader = response.body?.getReader()
    if (!reader) {
      status = "malformed"
      return fallback
    }
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        status = "malformed"
        void reader.cancel().catch(() => undefined)
        return fallback
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    status = "malformed"
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    const parsed = JevResponseSchema.safeParse(raw)
    const expectedKeys = ladder.map((_, index) => `tier_${index}`)
    if (!parsed.success || Object.keys(parsed.data.answers).length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(parsed.data.answers, key))) {
      status = "malformed"
      return fallback
    }
    scores = Object.fromEntries(ladder.map((tier, index) => [tier, parsed.data.answers[`tier_${index}`]?.noul ?? 0]))
    choice = ladder.find((tier) => (scores[tier] ?? 0) >= config.min_suitability) ?? fallback
    status = config.mode === "active" ? "selected" : "observed"
    return config.mode === "active" ? choice : fallback
  } catch {
    status = "unavailable"
    return fallback
  } finally {
    log(`[jev-routing] ${kind} decision`, {
      status,
      candidates: ladder,
      scores,
      ...(kind === "tier" ? { chosenCategory: choice } : { chosenAgent: choice }),
      latency_ms: Math.round(performance.now() - started),
    })
    signal?.throwIfAborted()
  }
}

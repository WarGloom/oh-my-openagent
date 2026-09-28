import { z } from "zod"
import type { CategoriesConfig, JevRoutingConfig } from "../../config/schema"
import { log } from "../../shared/logger"

const JEV_URL = "https://opencode.ai/zen/v1/systemone"
const JEV_MODEL = "jev-1.13-free"
const MAX_BRIEF_BYTES = 8192
const MAX_REQUEST_BYTES = 16384

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

export async function selectCategoryTierWithJev(input: JevRoutingInput): Promise<string | undefined> {
  const { brief, config, categories, enabledCategories, modelRouting, signal } = input
  signal?.throwIfAborted()
  const started = performance.now()
  const ladder = config?.ladder ?? []
  const fallback = config?.default
  const validTier = (name: string) => name !== "auto" && enabledCategories[name] !== undefined
  const validDefault = fallback !== undefined && validTier(fallback)
  const valid = Boolean(
    categories?.auto && !categories.auto.disable
    && Object.keys(categories.auto).every((key) => key === "description")
    && categories.auto.description?.trim()
    && validDefault && ladder.length >= 2 && ladder.length <= 8
    && new Set(ladder).size === ladder.length && ladder.every(validTier),
  )
  let status = "disabled"
  let scores: Record<string, number> = {}
  let choice = fallback
  try {
    if (!valid || !config) {
      status = "invalid_config"
      return validDefault ? fallback : undefined
    }
    if (config.mode === "off" || modelRouting === false) return fallback
    if (new TextEncoder().encode(brief).length > MAX_BRIEF_BYTES) {
      status = "oversized_brief"
      return fallback
    }
    const questions = Object.fromEntries(ladder.map((tier, index) => [
      `tier_${index}`,
      {
        type: "noul",
        instructions: `Score whether tier ${tier} is suitable for the current delegation brief. Category description: ${enabledCategories[tier]?.description ?? ""}. Score suitability only, not price or model capability claims.`,
        criteria: {
          true: `The delegation brief is suitable for tier ${tier}: ${enabledCategories[tier]?.description ?? ""}`,
          false: `The delegation brief is not suitable for tier ${tier}.`,
        },
      },
    ]))
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
    const raw: unknown = await response.json()
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
    log("[jev-routing] tier decision", {
      status,
      candidates: ladder,
      scores,
      chosenCategory: choice,
      latency_ms: Math.round(performance.now() - started),
    })
    signal?.throwIfAborted()
  }
}

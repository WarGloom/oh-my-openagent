import { z } from "zod"
import type { CategoriesConfig, JevRoutingConfig } from "../../config/schema"
import { log } from "../../shared/logger"
import { CATEGORY_DESCRIPTIONS } from "./constants"

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
  const started = performance.now()
  const ladder = config?.ladder ?? []
  const fallback = config?.default
  const { valid, validDefault } = getJevRoutingEligibility({ config, categories, enabledCategories })
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
    const questions = Object.fromEntries(ladder.map((tier, index) => {
      const description = categories?.[tier]?.description || CATEGORY_DESCRIPTIONS[tier] || ""
      return [
        `tier_${index}`,
        {
          type: "noul",
          instructions: `Score whether tier ${tier} is suitable for the current delegation brief. Category description: ${description}. Score suitability only, not price or model capability claims.`,
          criteria: {
            true: `The delegation brief is suitable for tier ${tier}: ${description}`,
            false: `The delegation brief is not suitable for tier ${tier}.`,
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

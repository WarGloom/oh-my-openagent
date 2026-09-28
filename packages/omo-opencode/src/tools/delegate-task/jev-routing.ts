import { z } from "zod"
import type { CategoryConfig, JevRoutingConfig } from "../../config/schema"
import { log } from "../../shared/logger"
import { parseModelString } from "../../shared/model-string-parser"

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

type CategoryModelEntry = NonNullable<CategoryConfig["models"]>[number]

function modelId(entry: CategoryModelEntry): string | undefined {
  const parsed = parseModelString(typeof entry === "string" ? entry : entry.model)
  return parsed ? `${parsed.providerID}/${parsed.modelID}` : undefined
}

export type JevRoutingInput = {
  readonly category: string
  readonly brief: string
  readonly config: JevRoutingConfig | undefined
  readonly canonicalModels: readonly CategoryModelEntry[] | undefined
  readonly usableModels: readonly CategoryModelEntry[] | undefined
  readonly availableModels: ReadonlySet<string>
  readonly signal?: AbortSignal
}

export async function selectCategoryModelWithJev(input: JevRoutingInput): Promise<CategoryModelEntry | undefined> {
  const { category, brief, config, canonicalModels, usableModels, availableModels, signal } = input
  signal?.throwIfAborted()
  if (!config || config.mode === "off") return undefined
  const candidates = config.categories[category]
  if (!candidates || !canonicalModels || !usableModels || canonicalModels.length < 2) return undefined

  const eligible = candidates.map((candidate) => ({
    ...candidate,
    entry: canonicalModels.find((entry) => modelId(entry) === candidate.model),
    usable: usableModels.find((entry) => modelId(entry) === candidate.model),
  }))
  const usable = eligible.filter((candidate) => candidate.entry && candidate.usable && availableModels.has(candidate.model))
  if (usable.length !== candidates.length || usable.length < 2
    || new Set(usable.map((candidate) => candidate.model)).size !== usable.length) return undefined
  if (new TextEncoder().encode(brief).length > MAX_BRIEF_BYTES) return undefined

  const questions = Object.fromEntries(usable.map((candidate, index) => [
    `candidate_${index}`,
    {
      type: "noul",
      instructions: `Score whether candidate ${index} (${candidate.model}) is suitable for the current delegation brief. Score suitability only, not price or model capability claims.`,
      criteria: {
        true: candidate.suitability,
        false: `Candidate ${index} does not meet this suitability criterion: ${candidate.suitability}`,
      },
    },
  ]))
  const body = JSON.stringify({ model: JEV_MODEL, state: brief, questions })
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) return undefined

  const started = performance.now()
  let status = "unavailable"
  let scores: Record<string, number> = {}
  let selectedModel: string | undefined
  try {
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
      return undefined
    }
    const raw: unknown = await response.json()
    const parsed = JevResponseSchema.safeParse(raw)
    const expectedKeys = usable.map((_, index) => `candidate_${index}`)
    if (!parsed.success || Object.keys(parsed.data.answers).length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(parsed.data.answers, key))) {
      status = "malformed"
      return undefined
    }
    scores = Object.fromEntries(expectedKeys.map((key) => [key, parsed.data.answers[key]?.noul ?? 0]))
    const selected = usable.find((_, index) => (scores[`candidate_${index}`] ?? 0) >= config.min_suitability)
    selectedModel = selected?.model
    status = selected ? (config.mode === "active" ? "selected" : "observed") : "no_suitable_candidate"
    return config.mode === "active" ? selected?.usable : undefined
  } catch {
    status = "unavailable"
    return undefined
  } finally {
    log("[jev-routing] category decision", {
      status,
      category,
      candidates: usable.map((candidate) => candidate.model),
      scores,
      selectedModel,
      latency_ms: Math.round(performance.now() - started),
    })
    signal?.throwIfAborted()
  }
}

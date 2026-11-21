import { z } from "zod"
import type { JevRoutingConfig } from "../../config/schema"
import { MODEL } from "./jev-router-model"

export const questions = {
  unknown_cause: {
    type: "noul",
    instructions: "Does the requested work require finding the cause of an unexplained failure in the brief?",
    criteria: {
      true: "The brief describes a failure and asks the worker to establish its cause.",
      false: "The brief asks for a known correction, a lookup, a review, or a check with an already identified cause.",
    },
  },
  cross_component: {
    type: "noul",
    instructions:
      "Does the brief ask the worker to reason about behavior at an interface between independently changing components?",
    criteria: {
      true: "The worker must reconcile behavior that depends on a contract between independently maintained components.",
      false: "The worker inspects one component, follows specified steps, or uses already established interface facts.",
    },
  },
  open_decision: {
    type: "noul",
    instructions: "Does the brief leave a material correctness decision for the worker to resolve?",
    criteria: {
      true: "The worker must decide which behavior is correct before delivering the result.",
      false: "The brief supplies the required behavior, evidence to collect, or a checklist for evaluating it.",
    },
  },
  specified_method: {
    type: "noul",
    instructions: "Does the brief specify a concrete method sufficient to finish this assignment?",
    criteria: {
      true: "The brief provides the method and enough inputs to execute it and recognize completion.",
      false: "The worker must choose how to investigate, design, or verify the result before it can finish.",
    },
  },
}

const probability = z.number().min(0).max(1)
const noul = z.object({ type: z.literal("noul"), noul: probability })
const replySchema = z.object({
  model: z.string(),
  answers: z.object({
    unknown_cause: noul,
    cross_component: noul,
    open_decision: noul,
    specified_method: noul,
  }),
})
type Scores = { readonly [K in keyof typeof questions]: number }
const LOW = 0.3
const HIGH = 0.7
const MAX_BRIEF_BYTES = 8192
const MAX_REQUEST_BYTES = 32768
const MAX_REPLY_BYTES = 65536

export function briefTier(scores: Scores): "lighter" | "stronger" {
  return scores.unknown_cause <= LOW &&
    scores.cross_component <= LOW &&
    scores.open_decision <= LOW &&
    scores.specified_method >= HIGH
    ? "lighter"
    : "stronger"
}

type Transport = { readonly backend: "typesafe" | "zen"; readonly latencyMs: number; readonly requestPayload?: string }
type Result = Transport &
  (
    | { readonly kind: "answer"; readonly scores: Scores; readonly model: string }
    | { readonly kind: "error"; readonly error: "oversized_request" | "http_error" | "malformed" | "unavailable" }
  )

export async function judgeNamedAgentBrief(input: {
  readonly role: string
  readonly brief: string
  readonly config: JevRoutingConfig
  readonly signal?: AbortSignal
}): Promise<Result> {
  const { role, brief, config, signal } = input
  signal?.throwIfAborted()
  const start = performance.now()
  const key = process.env[config.api_key_env]
  const backend = key ? "typesafe" : "zen"
  const transport = (requestPayload?: string): Transport => ({
    backend,
    latencyMs: performance.now() - start,
    requestPayload,
  })
  const model = key ? (config.model === "jev-latest" ? MODEL : config.model) : "jev-1.13-free"
  const requestPayload = JSON.stringify({ model, state: { role, brief }, questions })
  if (Buffer.byteLength(brief) > MAX_BRIEF_BYTES || Buffer.byteLength(requestPayload) > MAX_REQUEST_BYTES)
    return { ...transport(), kind: "error", error: "oversized_request" }
  try {
    const timeout = AbortSignal.timeout(config.timeout_ms)
    const response = await fetch(
      key ? "https://api.typesafe.ai/v1/systemone" : "https://opencode.ai/zen/v1/systemone",
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
        body: requestPayload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      return { ...transport(requestPayload), kind: "error", error: "http_error" }
    }
    const reader = response.body?.getReader()
    if (!reader) return { ...transport(requestPayload), kind: "error", error: "malformed" }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_REPLY_BYTES) {
          await reader.cancel()
          return { ...transport(requestPayload), kind: "error", error: "malformed" }
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const parsed = replySchema.safeParse(parseResponse(Buffer.concat(chunks).toString("utf8")))
    if (!parsed.success) return { ...transport(requestPayload), kind: "error", error: "malformed" }
    const answer = parsed.data.answers
    return {
      ...transport(requestPayload),
      kind: "answer",
      model: parsed.data.model,
      scores: {
        unknown_cause: answer.unknown_cause.noul,
        cross_component: answer.cross_component.noul,
        open_decision: answer.open_decision.noul,
        specified_method: answer.specified_method.noul,
      },
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    signal?.throwIfAborted()
    return { ...transport(requestPayload), kind: "error", error: "unavailable" }
  }
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
}

import { z } from "zod"
import { sha256, type Mode, type Question } from "./reply-check-ledger"

const THRESHOLD = 0.7
const responseSchema = z.object({
  model: z
    .string()
    .regex(/^[\w.:/-]{1,128}$/)
    .optional(),
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })),
})
export type JevQuestion = {
  readonly key: Question["question_key"]
  readonly name: string
  readonly instructions: string
}
export type JevQuestions = Readonly<Record<string, JevQuestion>>

export function replyJevPayload(state: object, questions: JevQuestions): string {
  return JSON.stringify({
    model: "jev-latest",
    state,
    questions: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [key, { type: "noul", instructions: question.instructions }]),
    ),
  })
}

export async function observeReplyJev(input: {
  readonly mode: Mode
  readonly key: string
  readonly body: string
  readonly questions: JevQuestions
  readonly signal: AbortSignal
  readonly evidence?: Question["evidence"]
  readonly observe?: (question: Question) => void
}): Promise<ReadonlySet<string> | undefined> {
  const start = performance.now()
  const timeout = AbortSignal.timeout(3000)
  let parsed: z.infer<typeof responseSchema> | undefined
  let error: Question["error"] = null
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: "Bearer " + input.key },
      body: input.body,
      signal: AbortSignal.any([input.signal, timeout]),
    })
    if (!response.ok) {
      error = "http_error"
      await response.body?.cancel()
    } else {
      const result = responseSchema.safeParse(await response.json())
      if (result.success) parsed = result.data
      else error = "malformed"
    }
  } catch (cause) {
    error ??= input.signal.aborted
      ? "cancelled"
      : timeout.aborted
        ? "timeout"
        : cause instanceof SyntaxError
          ? "malformed"
          : "unavailable"
  }
  const latency_ms = performance.now() - start
  const complete = error === null && Object.keys(input.questions).every((key) => parsed?.answers[key] !== undefined)
  const hits = new Set<string>()
  for (const [request_key, question] of Object.entries(input.questions)) {
    const probability = parsed?.answers[request_key]?.noul ?? null
    const finding = complete && probability !== null && probability >= THRESHOLD
    if (finding) hits.add(request_key)
    input.observe?.({
      mode: input.mode,
      request_key,
      question_key: question.key,
      question_name: question.name,
      question_sha256: sha256(question.instructions),
      probability,
      threshold: THRESHOLD,
      finding,
      latency_ms,
      model_id: parsed?.model ?? null,
      backend: "typesafe",
      error: error ?? (complete ? null : "malformed"),
      ...(input.evidence ? { evidence: input.evidence } : {}),
    })
  }
  return complete ? hits : undefined
}

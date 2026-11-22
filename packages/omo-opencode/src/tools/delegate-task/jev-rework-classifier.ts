import { z } from "zod"

const definitions = {
  round: {
    repair: "Repair a defect in the worker's existing deliverable or evidence.",
    early_stop: "Continue the same work after the worker stopped before delivery.",
    brief_correction: "Correct the supplied brief, its scope, or the interpretation of its requirements.",
    new_deliverable: "Request a distinct new deliverable or a planned new phase, not a correction.",
    other: "Acknowledgment, administrative update, clarification without correction, or other.",
  },
  report: {
    delivered: "The report states that the requested outcome was delivered.",
    partial:
      "The report states that only part of the requested outcome was delivered and does not make a concrete evidence-backed blocker its main result.",
    not_delivered: "The report states no substantive delivery and names no concrete evidence-backed blocker.",
    blocked: "The report supplies a concrete blocker and evidence that it prevented delivery.",
    question: "The report mainly asks the caller to supply a decision or information.",
    empty: "The report conveys no substantive information.",
  },
} as const

const parsed = z.object({
  answers: z.object({
    classification: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
})

type Failure = "no_key" | "over_limit" | "http_error" | "malformed" | "unavailable"
const failure = (error: Failure) => ({ classification: "unclassified", probabilities: null, error })

export async function classifyRework(kind: keyof typeof definitions, text: string) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) return failure("no_key")
  const criteria = definitions[kind]
  const body = JSON.stringify({
    model: "jev-latest",
    state: kind === "round" ? { prompt: text } : { report: text },
    questions: {
      classification: {
        type: "choice",
        instructions:
          kind === "round"
            ? "What does the parent ask for in this follow-up prompt?"
            : "What outcome does this worker report state?",
        criteria,
      },
    },
  })
  if (Buffer.byteLength(body) > 24_000) return failure("over_limit")
  try {
    const result = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body,
      signal: AbortSignal.timeout(1200),
    })
    if (!result.ok) {
      await result.body?.cancel()
      return failure("http_error")
    }
    const answer = parsed.safeParse(await result.json())
    if (!answer.success) return failure("malformed")
    const { choice, probabilities } = answer.data.answers.classification
    const labels = Object.keys(criteria)
    if (!labels.includes(choice) || !labels.every((label) => Object.hasOwn(probabilities, label)))
      return failure("malformed")
    return {
      classification: choice,
      probabilities: Object.fromEntries(labels.map((label) => [label, probabilities[label]])),
      error: null,
    }
  } catch (error) {
    return failure(error instanceof SyntaxError ? "malformed" : "unavailable")
  }
}

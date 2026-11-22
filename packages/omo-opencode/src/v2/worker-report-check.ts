import { z } from "zod"
import type { WorkerReportCheck } from "../config/schema/reply-check"
import type { V2SessionMessage } from "./context-types"

const MAX_REQUEST_BYTES = 24_000
const MAX_SEMANTIC_SENTENCES = 24
const HIGH = 0.7
const scores = z.object({
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })),
})
const words = (values: readonly string[]) =>
  values.map((value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|")
const left = "(?<![\\p{L}\\p{N}_])"
const right = "(?![\\p{L}\\p{N}_])"

function report(message: V2SessionMessage) {
  if (message.type !== "synthetic") return undefined
  const match = /^<background-result kind="(?:subagent|task)"[^\n>]*>\n([\s\S]*)\n<\/background-result>\s*$/.exec(
    message.text,
  )
  if (!match?.[1]) return undefined
  return { exact: message.text, final: match[1] }
}

export async function workerReportFindings(
  config: WorkerReportCheck,
  input: {
    readonly history: readonly V2SessionMessage[]
    readonly reply: string
    readonly signal: AbortSignal
    readonly warn: (message: string) => void
  },
) {
  const { history, reply, signal, warn } = input
  const priorIdle = history.slice(0, -1).findLastIndex((message) => message.type === "idle")
  const current = history.slice(priorIdle + 1).flatMap((message) => report(message) ?? [])
  if (!current.length) return []
  const reports = history.flatMap((message) => report(message) ?? [])
  const sentences = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(reply)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean)
  const attribution = new RegExp(config.attribution, "iu")
  const verdict = config.verdicts.length
    ? new RegExp(left + "(?:" + words(config.verdicts) + ")" + right, "gu")
    : undefined
  const count = config.units.length
    ? new RegExp(
        left +
          "(?:([+-]?\\d+(?:[.,]\\d+)*)[ \\t]+(" +
          words(config.units) +
          ")|(" +
          words(config.units) +
          ")[ \\t]*[:=]?[ \\t]*([+-]?\\d+(?:[.,]\\d+)*))" +
          right,
        "giu",
      )
    : undefined
  const values = (text: string) =>
    count
      ? [...text.matchAll(count)].map((m) => ({
          text: m[0],
          key: (m[1] ?? m[4]) + ":" + (m[2] ?? m[3])?.toLowerCase(),
        }))
      : []
  const supportedCounts = new Set(reports.flatMap((item) => values(item.final).map((value) => value.key)))
  const supportedVerdicts = new Set(
    verdict ? reports.flatMap((item) => [...item.final.matchAll(verdict)].map((match) => match[0])) : [],
  )
  const findings = sentences.flatMap((sentence) => {
    const unsupportedCounts = values(sentence)
      .filter((value) => !supportedCounts.has(value.key))
      .map((value) => value.text)
    const unsupportedVerdicts =
      verdict && attribution.test(sentence)
        ? [...sentence.matchAll(verdict)].map((match) => match[0]).filter((value) => !supportedVerdicts.has(value))
        : []
    const unsupported = [...new Set([...unsupportedCounts, ...unsupportedVerdicts])]
    return unsupported.length
      ? [
          {
            rule: config.exact,
            text: sentence,
            provenance: "Not found in delivered reports: " + unsupported.join(", "),
          },
        ]
      : []
  })
  const key = process.env.TYPESAFE_API_KEY
  if (!config.jev || !key) return findings
  const rules = config.jev
  if (sentences.length > MAX_SEMANTIC_SENTENCES) {
    warn("Reply check: reply exceeds the worker-report TypeSafe question limit.")
    return findings
  }
  const questions = {
    omitted: { type: "noul", instructions: rules.omitted },
    ...Object.fromEntries(
      sentences.map((_, i) => [
        "sentence_" + i,
        {
          type: "noul",
          instructions:
            rules.unsupported +
            " Evaluate only sentence " +
            i +
            " in state.sentences as the claim; state.reply is context.",
        },
      ]),
    ),
  }
  for (const item of current) {
    if (signal.aborted) break
    const payload = (report: string) =>
      JSON.stringify({ model: "jev-latest", state: { report, reply, sentences }, questions })
    const full = payload(item.exact)
    const finalOnly = Buffer.byteLength(full) > MAX_REQUEST_BYTES
    const body = finalOnly ? payload(item.final) : full
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      warn("Reply check: worker report exceeds the TypeSafe input limit even without its delivery envelope.")
      continue
    }
    const provenance = finalOnly
      ? "TypeSafe input: worker final message only (delivery envelope exceeded input limit)."
      : "TypeSafe input: exact delivered worker report."
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error("TypeSafe request failed")
      }
      const { answers } = scores.parse(await response.json())
      if (Object.keys(questions).some((name) => !Object.hasOwn(answers, name)))
        throw new Error("TypeSafe answer missing")
      const rule = (name: string) => ({ name, citation: rules.citation, rule_text: rules.rule_text })
      for (const [i, sentence] of sentences.entries()) {
        if ((answers["sentence_" + i]?.noul ?? 0) >= HIGH)
          findings.push({ rule: rule(rules.unsupported), text: sentence, provenance })
      }
      if ((answers.omitted?.noul ?? 0) >= HIGH) {
        const sentence = sentences.find((value) => attribution.test(value)) ?? sentences[0]
        if (sentence)
          findings.push({
            rule: rule(rules.omitted),
            text: sentence,
            provenance: provenance + " Omission judged against the complete reply.",
          })
      }
    } catch {
      if (!signal.aborted) warn("Reply check: worker-report TypeSafe judgment unavailable.")
    }
  }
  return findings
}

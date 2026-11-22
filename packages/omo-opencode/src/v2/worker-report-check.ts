import { observeReplyJev, replyJevPayload, type JevQuestions } from "./reply-check-jev"
import { sha256, type CodeFinding, type Question, type Skip } from "./reply-check-ledger"
import type { WorkerReportCheck } from "../config/schema/reply-check"
import type { V2SessionMessage } from "./context-types"

const MAX_REQUEST_BYTES = 24_000
const MAX_SEMANTIC_SENTENCES = 24
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
  return { id: message.id, exact: message.text, final: match[1] }
}

export async function workerReportFindings(
  config: WorkerReportCheck,
  input: {
    readonly history: readonly V2SessionMessage[]
    readonly reply: string
    readonly signal: AbortSignal
    readonly warn: (message: string) => void
    readonly observe?: (question: Question) => void
    readonly code?: (finding: CodeFinding) => void
    readonly mode?: (ran: boolean, skip: Skip | null) => void
  },
) {
  const { history, reply, signal, warn } = input
  const priorIdle = history.slice(0, -1).findLastIndex((message) => message.type === "idle")
  const current = history.slice(priorIdle + 1).flatMap((message) => report(message) ?? [])
  if (!current.length) {
    input.mode?.(false, "no_report_in_turn")
    return []
  }
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
          key: m[1] ?? m[4],
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
    const matches = [...unsupportedCounts, ...unsupportedVerdicts]
    const unsupported = [...new Set(matches)]
    if (matches.length) input.code?.({ rule: config.exact.name, count: matches.length })
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
  if (!config.jev || !key) {
    input.mode?.(true, config.jev ? "no_key" : "disabled")
    return findings
  }
  const rules = config.jev
  if (sentences.length > MAX_SEMANTIC_SENTENCES) {
    input.mode?.(true, "reply_over_limit")
    warn("Reply check: reply exceeds the worker-report TypeSafe question limit.")
    return findings
  }
  const questions: JevQuestions = {
    omitted: { key: "omitted", name: rules.omitted, instructions: rules.omitted },
    ...Object.fromEntries(
      sentences.map((_, i) => [
        "sentence_" + i,
        {
          key: "unsupported",
          name: rules.unsupported,
          instructions:
            rules.unsupported +
            " Evaluate only sentence " +
            i +
            " in state.sentences as the claim; state.reply is context.",
        },
      ]),
    ),
  }
  let attempted = false
  for (const item of current) {
    if (signal.aborted) break
    const state = (report: string) => ({ report, reply, sentences })
    const full = replyJevPayload(state(item.exact), questions)
    const finalOnly = Buffer.byteLength(full) > MAX_REQUEST_BYTES
    const sent = state(finalOnly ? item.final : item.exact)
    const body = finalOnly ? replyJevPayload(sent, questions) : full
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      warn("Reply check: worker report exceeds the TypeSafe input limit even without its delivery envelope.")
      continue
    }
    const provenance = finalOnly
      ? "TypeSafe input: worker final message only (delivery envelope exceeded input limit)."
      : "TypeSafe input: exact delivered worker report."
    attempted = true
    const serialized = JSON.stringify(sent)
    const hits = await observeReplyJev({
      mode: "worker_reports",
      key,
      body,
      questions,
      signal,
      observe: input.observe,
      evidence: {
        report_message_ids: [item.id],
        state_sha256: sha256(serialized),
        state_bytes: Buffer.byteLength(serialized),
        report_input: finalOnly ? "final_message" : "whole_report",
      },
    })
    if (!hits) {
      if (!signal.aborted) warn("Reply check: worker-report TypeSafe judgment unavailable.")
      continue
    }
    const rule = (name: string) => ({ name, citation: rules.citation, rule_text: rules.rule_text })
    for (const [i, sentence] of sentences.entries()) {
      if (hits.has("sentence_" + i)) findings.push({ rule: rule(rules.unsupported), text: sentence, provenance })
    }
    if (hits.has("omitted")) {
      const sentence = sentences.find((value) => attribution.test(value)) ?? sentences[0]
      if (sentence)
        findings.push({
          rule: rule(rules.omitted),
          text: sentence,
          provenance: provenance + " Omission judged against the complete reply.",
        })
    }
  }
  input.mode?.(true, attempted ? null : signal.aborted ? "cancelled" : "state_over_limit")
  return findings
}

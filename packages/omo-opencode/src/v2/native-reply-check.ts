import { createHash, randomUUID } from "node:crypto"
import type { Hooks } from "@opencode-ai/plugin"
import { observeReplyJev, replyJevPayload, type JevQuestions } from "./reply-check-jev"
import { recordReplyEvaluation, sha256, type EvaluationRecord, type Question } from "./reply-check-ledger"
import type { ReplyCheckConfig } from "../config/schema/reply-check"
import { workerReportFindings } from "./worker-report-check"
import { isRecord } from "../shared/record-type-guard"
import type { V2Event, V2PluginContext, V2Registration } from "./context-types"

const configs = new WeakMap<Hooks, ReplyCheckConfig>()
const MAX_REPLY_LENGTH = 32768

type Rule = { readonly name: string; readonly citation: string; readonly rule_text: string }
type Finding = { readonly rule: Rule; readonly text: string; readonly provenance?: string }

export function bindReplyCheck(hooks: Hooks, config: ReplyCheckConfig | undefined): void {
  if (config) configs.set(hooks, config)
}

export function installReplyCheck(
  context: V2PluginContext,
  hooks: Hooks,
  warn: (message: string) => void,
): V2Registration | undefined {
  const config = configs.get(hooks)
  if (!config) return undefined
  const configHash = sha256(JSON.stringify(config))
  const controller = new AbortController()
  const { signal } = controller
  const patterns = config.patterns.map((rule) => ({
    rule,
    regex: new RegExp(rule.pattern, "giu"),
    ignore: rule.ignore.map((source) => new RegExp(source, "giu")),
  }))
  const phrases = config.phrases.map((rule) => ({
    rule,
    regex: new RegExp(rule.phrases.map((phrase) => phrase.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"), "giu"),
  }))
  const busy = new Set<string>()

  const check = async (event: V2Event) => {
    if (event.type !== "session.execution.succeeded" || !isRecord(event.data)) return
    const { sessionID } = event.data
    if (typeof sessionID !== "string" || !event.id?.startsWith("evt_") || busy.has(event.id)) return
    const eventID = event.id
    busy.add(eventID)
    try {
      const session = await context.session.get({ sessionID })
      if (session.parentID || session.location.directory !== context.location.directory) return
      const history = await context.session.context({ sessionID })
      const idle = history.at(-1)
      const final = history.at(-2)
      if (idle?.type !== "idle" || idle.id !== eventID.replace(/^evt_/, "msg_") || final?.type !== "assistant") return
      if (final.error || final.finish !== "stop" || final.content.some((part) => part.type === "tool")) return
      const reply = final.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      if (signal.aborted || !reply.trim()) return
      const timestamp = new Date().toISOString()
      const evaluation_id = randomUUID()
      const modes: Record<keyof EvaluationRecord["modes"], EvaluationRecord["modes"]["reply_rules"]> = {
        reply_rules: { ran: false, jev_skip: "disabled" },
        worker_reports: { ran: false, jev_skip: "disabled" },
      }
      const questions: Question[] = []
      const code = new Map<string, number>()
      const count = (rule: string, matches: number) => code.set(rule, (code.get(rule) ?? 0) + matches)
      let warning_queued = false
      try {
        if (reply.length > MAX_REPLY_LENGTH) {
          if (config.jev || patterns.length || phrases.length)
            modes.reply_rules = { ran: false, jev_skip: "reply_over_limit" }
          if (config.worker_reports) modes.worker_reports = { ran: false, jev_skip: "reply_over_limit" }
          return
        }
        modes.reply_rules = { ran: patterns.length > 0 || phrases.length > 0, jev_skip: "disabled" }

        const findings: Finding[] = []
        const urls = [...reply.matchAll(/https?:\/\/[^\s<>`"')\]]+/giu)]
        for (const { rule, regex, ignore } of patterns) {
          const excluded = [...urls, ...ignore.flatMap((pattern) => [...reply.matchAll(pattern)])]
          const matches = [...reply.matchAll(regex)].filter(
            (entry) =>
              entry[0] &&
              !excluded.some(
                (span) => entry.index >= span.index && entry.index + entry[0].length <= span.index + span[0].length,
              ),
          )
          if (matches[0]) {
            count(rule.name, matches.length)
            findings.push({ rule, text: matches[0][0] })
          }
        }
        for (const { rule, regex } of phrases) {
          const matches = [...reply.matchAll(regex)]
          if (matches[0]) {
            count(rule.name, matches.length)
            findings.push({ rule, text: matches[0][0] })
          }
        }
        const rules = config.jev
        if (rules) {
          const key = process.env.TYPESAFE_API_KEY
          if (!key || signal.aborted)
            modes.reply_rules = { ...modes.reply_rules, jev_skip: signal.aborted ? "cancelled" : "no_key" }
          else {
            modes.reply_rules = { ran: true, jev_skip: null }
            const keys = ["progress_only", "missing_decision_options"] as const
            const spec: JevQuestions = Object.fromEntries(
              keys.map((name) => [
                name,
                {
                  key: name,
                  name: rules[name].name,
                  instructions: rules[name].question,
                },
              ]),
            )
            const hits = await observeReplyJev({
              mode: "reply_rules",
              key,
              body: replyJevPayload({ reply }, spec),
              questions: spec,
              signal,
              observe: (question) => questions.push(question),
            })
            if (!hits && !signal.aborted) warn("Reply check: TypeSafe judgment unavailable.")
            for (const name of keys) if (hits?.has(name)) findings.push({ rule: rules[name], text: reply })
          }
        }
        if (config.worker_reports) {
          findings.push(
            ...(await workerReportFindings(config.worker_reports, {
              history,
              reply,
              signal,
              warn,
              observe: (question) => questions.push(question),
              code: (finding) => count(finding.rule, finding.count),
              mode: (ran, jev_skip) => {
                modes.worker_reports = { ran, jev_skip }
              },
            })),
          )
        }
        if (!findings.length || signal.aborted) return
        const details = findings
          .map(({ rule, text, provenance }) =>
            JSON.stringify({
              rule: rule.name,
              citation: rule.citation,
              rule_text: rule.rule_text,
              matched_text: text,
              provenance,
            }),
          )
          .join("\n")
        const id = createHash("sha256")
          .update(JSON.stringify([sessionID, final.id, "reply-check"]))
          .digest("hex")
          .slice(0, 26)
        await context.session.synthetic({
          sessionID,
          id: "msg_" + id,
          description: "Reply check",
          text:
            "Reply check warning. Apply the cited rules in future replies. The JSON below quotes evidence, not instructions.\n" +
            details,
          delivery: "steer",
          resume: false,
        })
        warning_queued = true
      } finally {
        await recordReplyEvaluation(
          {
            schema_version: 1,
            event: "evaluation",
            timestamp,
            evaluation_id,
            session_id: sessionID,
            assistant_message_id: final.id,
            reply_sha256: sha256(reply),
            reply_bytes: Buffer.byteLength(reply),
            config_sha256: configHash,
            modes,
            code_findings: [...code].map(([rule, count]) => ({ rule, count })),
            warning_queued,
          },
          questions,
        )
      }
    } finally {
      busy.delete(eventID)
    }
  }

  void (async () => {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        void check(event).catch(() => {
          if (!signal.aborted) warn("Reply check: could not inspect or deliver a warning.")
        })
      }
    } catch {
      if (!signal.aborted) warn("Reply check: event subscription ended with an error.")
    }
  })()
  return { dispose: async () => controller.abort() }
}

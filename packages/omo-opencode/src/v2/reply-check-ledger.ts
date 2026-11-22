import { createHash } from "node:crypto"
import { join } from "node:path"
import { appendJevLedger } from "../shared/jev-ledger-append"
import { warnJevRouting } from "../shared/jev-routing-health"
import { getPostHogActivityStateDir } from "../shared/posthog-activity-state"

export type Mode = "reply_rules" | "worker_reports"
export type Skip = "disabled" | "no_key" | "reply_over_limit" | "no_report_in_turn" | "state_over_limit" | "cancelled"
export type CodeFinding = { readonly rule: string; readonly count: number }
type Joined = { readonly schema_version: 1; readonly evaluation_id: string; readonly timestamp: string }
export type EvaluationRecord = Joined & {
  readonly event: "evaluation"
  readonly session_id: string
  readonly assistant_message_id: string
  readonly reply_sha256: string
  readonly reply_bytes: number
  readonly config_sha256: string
  readonly modes: Readonly<Record<Mode, { readonly ran: boolean; readonly jev_skip: Skip | null }>>
  readonly code_findings: readonly CodeFinding[]
  readonly warning_queued: boolean
}
export type Question = {
  readonly mode: Mode
  readonly question_key: "progress_only" | "missing_decision_options" | "unsupported" | "omitted"
  readonly request_key: string
  readonly question_name: string
  readonly question_sha256: string
  readonly probability: number | null
  readonly threshold: number
  readonly finding: boolean
  readonly latency_ms: number
  readonly model_id: string | null
  readonly backend: "typesafe"
  readonly error: "http_error" | "malformed" | "timeout" | "unavailable" | "cancelled" | null
  readonly evidence?: {
    readonly report_message_ids: readonly string[]
    readonly state_sha256: string
    readonly state_bytes: number
    readonly report_input: "whole_report" | "final_message"
  }
}
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")
export const replyCheckLedgerDirectory = (): string => join(getPostHogActivityStateDir(), "jev-reply-check")

export async function recordReplyEvaluation(
  evaluation: EvaluationRecord,
  questions: readonly Question[],
): Promise<void> {
  const directory = replyCheckLedgerDirectory()
  try {
    const { schema_version, evaluation_id, timestamp } = evaluation
    const records = [
      evaluation,
      ...questions.map((question) => ({ schema_version, evaluation_id, timestamp, event: "question", ...question })),
    ]
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n")
    await appendJevLedger(directory, "evaluations-" + timestamp.slice(0, 7), bytes)
  } catch {
    await warnJevRouting("ledger_write_failures", directory, "jev-reply-check")
  }
}

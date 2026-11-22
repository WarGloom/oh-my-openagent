import { randomUUID } from "node:crypto"
import { appendJevLedger } from "../../shared/jev-ledger-append"
import { z } from "zod"
import { getJevRoutingStateDirectory, warnJevRouting } from "../../shared/jev-routing-health"

const identifier = z.string().min(1).max(256)
const category = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
const probability = z.number().min(0).max(1)
const ranking = z.object({ category, probability }).strict()
const common = {
  schema_version: z.literal(1),
  event_id: z.uuid(),
  timestamp: z.iso.datetime(),
  decision_id: z.uuid(),
}
const NamedSkipReasonSchema = z.enum([
  "no_opt_in",
  "explicit_model",
  "opt_out",
  "continuation",
  "pinned_by_rule",
  "no_available_pair",
  "oversized_request",
  "router_failure",
])
const NamedSkipSchema = z
  .object({
    ...common,
    event: z.literal("named_skip"),
    agent: identifier,
    surface: z.enum(["task", "subagent"]),
    parent_session_id: identifier.nullable(),
    reason: NamedSkipReasonSchema,
  })
  .strict()
export type NamedSkipReason = z.infer<typeof NamedSkipReasonSchema>

const DecisionSchema = z
  .object({
    ...common,
    event: z.literal("decision"),
    parent_session_id: identifier.nullable(),
    parent_decision_id: z.uuid().nullable(),
    hint_status: z.enum(["not_produced", "produced", "delivered", "missed_budget"]).optional(),
    surface: z.enum(["task", "team", "ladder", "subagent"]),
    mode: z.enum(["active", "observe"]),
    orchestrator_category: category,
    chosen_category: category.nullable(),
    named_model: z
      .object({
        agent: identifier,
        selected_model: identifier.nullable(),
        action: z.enum(["automatic", "default"]),
        skip_reason: NamedSkipReasonSchema.optional(),
        fallback_plan: z.array(identifier),
        request_payload: z.string().max(32768).optional(),
      })
      .strict()
      .optional(),
    top1: ranking.nullable(),
    top2: ranking.nullable(),
    answers: z.record(z.string(), z.union([probability, z.array(probability)])).nullable(),
    artifact_id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    jev_model_id: identifier.nullable(),
    latency_ms: z.number().nonnegative(),
    input_tokens: z.number().int().nonnegative().nullable(),
    backend: z.enum(["typesafe", "zen"]),
    error: z
      .enum([
        "disabled",
        "invalid_config",
        "unknown_artifact",
        "model_mismatch",
        "oversized_request",
        "state_error",
        "incomplete_input",
        "domain_conflict",
        "domain_uncertain",
        "http_error",
        "malformed",
        "unavailable",
        "cancelled",
        "category_unavailable",
      ])
      .nullable(),
    brief_status: z.enum(["none", "resolved", "unresolved", "truncated"]),
    would_block: z.boolean(),
    reason_codes: z.array(
      z.enum([
        "referenced_brief_unresolved",
        "empty_prompt",
        "outside_root",
        "missing",
        "unreadable",
        "symlink",
        "not_regular",
        "oversized",
        "domain_conflict",
        "domain_uncertain",
      ]),
    ),
    config_generation: z.string().regex(/^[a-f0-9]{64}$/),
    brief_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    brief_bytes: z.number().int().nonnegative(),
  })
  .strict()
const AttemptSchema = z
  .object({
    ...common,
    event: z.literal("attempt"),
    attempt_id: identifier,
    child_session_id: identifier.nullable(),
    task_id: identifier,
    cause: z.enum(["initial", "retry", "fallback_replacement", "continuation"]),
    resolved_model: identifier.nullable(),
  })
  .strict()
const OutcomeSchema = z
  .object({
    ...common,
    event: z.literal("outcome"),
    attempt_id: identifier,
    task_id: identifier,
    child_session_id: identifier.nullable(),
    status: z.enum(["completed", "failed", "cancelled", "escalated", "interrupted"]),
    producing_model: identifier.nullable(),
  })
  .strict()
const ReworkCommon = { ...common, parent_session_id: identifier, child_session_id: identifier }
const Classification = {
  classification: z.string().regex(/^[a-z_]{1,64}$/),
  probabilities: z.record(z.string().regex(/^[a-z_]{1,64}$/), probability).nullable(),
  error: z.enum(["no_key", "over_limit", "http_error", "malformed", "unavailable"]).nullable(),
}
const Digest = { text_sha256: z.string().regex(/^[a-f0-9]{64}$/), text_bytes: z.number().int().nonnegative() }
const DispatchSchema = z.object({ ...ReworkCommon, event: z.literal("dispatch"), category: identifier }).strict()
const ReportSchema = z
  .object({
    ...ReworkCommon,
    ...Digest,
    ...Classification,
    event: z.literal("report"),
    report_message_id: identifier,
    terminal: z.boolean(),
    report_state: z
      .string()
      .regex(/^[a-z_]{1,32}$/)
      .optional(),
    producing_model: identifier.nullable(),
  })
  .strict()
const RoundSchema = z
  .object({
    ...ReworkCommon,
    ...Digest,
    ...Classification,
    event: z.literal("round"),
    tool_call_id: identifier,
    round_index: z.number().int().positive(),
  })
  .strict()
const ReplacementSchema = z
  .object({
    ...ReworkCommon,
    event: z.literal("replacement"),
    replaced_child_session_id: identifier,
    replaced_decision_id: z.uuid(),
  })
  .strict()
const ClaimCheckSchema = z
  .object({
    ...common,
    event: z.literal("claim_check"),
    parent_session_id: identifier,
    tool_call_id: identifier,
    tool: z.enum(["jev_verify", "jev_compare", "jev_audit"]),
    claim_sha256: Digest.text_sha256,
    claim_bytes: Digest.text_bytes,
    evidence_sha256: Digest.text_sha256,
    evidence_bytes: Digest.text_bytes,
    judgments: z
      .array(
        z.object({
          verdict: z
            .string()
            .regex(/^[a-zA-Z_ -]{1,40}$/)
            .nullable(),
          probability: probability.nullable(),
        }),
      )
      .max(128),
    latency_ms: z.number().nonnegative(),
    status: z.enum(["completed", "error"]),
  })
  .strict()
const RecordSchema = z.discriminatedUnion("event", [
  DecisionSchema,
  AttemptSchema,
  OutcomeSchema,
  NamedSkipSchema,
  DispatchSchema,
  ReportSchema,
  RoundSchema,
  ReplacementSchema,
  ClaimCheckSchema,
])
export type JevDecisionRecord = z.infer<typeof DecisionSchema>
export type JevRoutingRecord = z.infer<typeof RecordSchema>

export function getJevLedgerDirectory(): string {
  return getJevRoutingStateDirectory()
}

export async function appendJevRoutingRecord(record: JevRoutingRecord): Promise<void> {
  const parsed = RecordSchema.parse(record)
  const bytes = Buffer.from(JSON.stringify(parsed) + "\n")
  const directory = getJevLedgerDirectory()
  const month = parsed.timestamp.slice(0, 7)
  const stem = `decisions-${month}`
  await appendJevLedger(directory, stem, bytes)
}

export function recordJevRouting(record: JevRoutingRecord): Promise<void> {
  return appendJevRoutingRecord(record).catch(() => warnJevRouting("ledger_write_failures"))
}

export function recordNamedRoutingSkip(input: {
  readonly agent: string
  readonly surface: "task" | "subagent"
  readonly parentSessionID?: string
  readonly reason: NamedSkipReason
}): Promise<void> {
  return recordJevRouting({
    schema_version: 1,
    event: "named_skip",
    timestamp: new Date().toISOString(),
    decision_id: randomUUID(),
    event_id: randomUUID(),
    agent: input.agent,
    surface: input.surface,
    parent_session_id: input.parentSessionID ?? null,
    reason: input.reason,
  })
}

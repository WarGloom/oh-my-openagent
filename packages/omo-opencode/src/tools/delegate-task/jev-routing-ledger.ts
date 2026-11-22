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
const RecordSchema = z.discriminatedUnion("event", [DecisionSchema, AttemptSchema, OutcomeSchema, NamedSkipSchema])
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

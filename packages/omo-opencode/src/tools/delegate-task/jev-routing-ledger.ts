import { constants } from "node:fs"
import { mkdir, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
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
const DecisionSchema = z
  .object({
    ...common,
    event: z.literal("decision"),
    parent_session_id: identifier.nullable(),
    parent_decision_id: z.uuid().nullable(),
    surface: z.enum(["task", "team", "ladder"]),
    mode: z.enum(["active", "observe"]),
    orchestrator_category: category,
    chosen_category: category.nullable(),
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
const RecordSchema = z.discriminatedUnion("event", [DecisionSchema, AttemptSchema, OutcomeSchema])
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
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await withLock(join(directory, ".append.lock"), async () => {
    const parts = (await readdir(directory)).flatMap((name) => {
      const match = new RegExp(`^${stem}(?:\\.(\\d+))?\\.jsonl$`).exec(name)
      return match ? [Number(match[1] ?? 0)] : []
    })
    let part = Math.max(0, ...parts)
    while (true) {
      const path = join(directory, `${stem}${part ? `.${part}` : ""}.jsonl`)
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.chmod(0o600)
        if ((await file.stat()).size + bytes.length > 50 * 1024 * 1024) {
          part++
          continue
        }
        if ((await file.write(bytes)).bytesWritten !== bytes.length)
          throw new RangeError("Incomplete routing ledger append")
        await file.sync()
        return
      } finally {
        await file.close()
      }
    }
  })
}

export function recordJevRouting(record: JevRoutingRecord): Promise<void> {
  return appendJevRoutingRecord(record).catch(() => warnJevRouting("ledger_write_failures"))
}

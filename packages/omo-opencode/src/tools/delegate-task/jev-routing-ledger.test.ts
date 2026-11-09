import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendJevRoutingRecord, getJevLedgerDirectory, type JevDecisionRecord } from "./jev-routing-ledger"
import { parseJevCategoryResponse } from "./jev-router-model"
import { PG_ARTIFACT } from "./jev-router-artifacts"
import { categoryReply } from "./jev-router.test-support"

describe("durable Jev ledger", () => {
  let directory: string
  const originalDataHome = process.env.XDG_DATA_HOME
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jev-ledger-"))
    process.env.XDG_DATA_HOME = directory
  })
  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    rmSync(directory, { recursive: true, force: true })
  })

  function decision(): JevDecisionRecord {
    const result = parseJevCategoryResponse(categoryReply())
    return {
      schema_version: 1,
      event_id: randomUUID(),
      event: "decision",
      timestamp: "2026-11-08T12:00:00.000Z",
      decision_id: randomUUID(),
      mode: "active",
      parent_session_id: "ses_parent",
      parent_decision_id: null,
      surface: "task",
      orchestrator_category: "omitted",
      chosen_category: "visual-engineering",
      top1: result.ranking[0],
      top2: result.ranking[1],
      answers: result.answers,
      artifact_id: PG_ARTIFACT.artifact_id,
      jev_model_id: result.model,
      latency_ms: 100,
      input_tokens: result.inputTokens,
      backend: "typesafe",
      error: null,
      brief_status: "none",
      would_block: false,
      reason_codes: [],
      config_generation: "f".repeat(64),
      brief_sha256: createHash("sha256").update("PRIVATE PROMPT").digest("hex"),
      brief_bytes: 14,
    }
  }

  test("appends private numeric records in the XDG data home without storing text", async () => {
    const record = decision()
    await appendJevRoutingRecord(record)
    await appendJevRoutingRecord({
      schema_version: 1,
      event_id: randomUUID(),
      event: "attempt",
      timestamp: record.timestamp,
      decision_id: record.decision_id,
      attempt_id: "att_child",
      child_session_id: "ses_child",
      task_id: "bg_child",
      cause: "initial",
      resolved_model: "example/model",
    })
    const path = join(getJevLedgerDirectory(), "decisions-2026-11.jsonl")
    const raw = readFileSync(path, "utf8")
    expect(path.startsWith(directory + "/")).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const rows = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toEqual([
      record,
      expect.objectContaining({
        event: "attempt",
        child_session_id: "ses_child",
        task_id: "bg_child",
        decision_id: record.decision_id,
      }),
    ])
    expect(Object.keys(rows[0].answers)).toHaveLength(14)
    expect(
      Object.values(rows[0].answers)
        .flat()
        .every((value) => typeof value === "number"),
    ).toBe(true)
    expect(raw).not.toContain("PRIVATE PROMPT")
    expect(raw).not.toContain("instructions")
    const contaminated = { ...record, prompt: "PRIVATE PROMPT" }
    await expect(appendJevRoutingRecord(contaminated)).rejects.toThrow()
    expect(readFileSync(path, "utf8")).toBe(raw)
  })

  test("rotates full monthly parts without deleting old files and repairs mode", async () => {
    const record = decision()
    await appendJevRoutingRecord(record)
    const base = join(getJevLedgerDirectory(), "decisions-2026-11.jsonl")
    truncateSync(base, 50 * 1024 * 1024)
    chmodSync(base, 0o644)
    await appendJevRoutingRecord(record)
    await appendJevRoutingRecord({ ...record, timestamp: "2026-12-01T00:00:00.000Z" })
    expect(readdirSync(getJevLedgerDirectory()).sort()).toEqual([
      "decisions-2026-11.1.jsonl",
      "decisions-2026-11.jsonl",
      "decisions-2026-12.jsonl",
    ])
    expect(statSync(base).size).toBe(50 * 1024 * 1024)
    expect(statSync(base).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(getJevLedgerDirectory(), "decisions-2026-11.1.jsonl"), "utf8"))).toEqual(record)
  })

  test("serializes concurrent whole-line appends across one rotating file", async () => {
    const records = Array.from({ length: 6 }, decision)
    await Promise.all(records.map(appendJevRoutingRecord))
    const rows = readFileSync(join(getJevLedgerDirectory(), "decisions-2026-11.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map((row) => row.decision_id))).toEqual(new Set(records.map((row) => row.decision_id)))
  })
})

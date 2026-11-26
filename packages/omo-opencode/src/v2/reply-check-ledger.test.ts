import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as drainEventTurn } from "node:timers/promises"
import type { Hooks } from "@opencode-ai/plugin"
import { ReplyCheckConfigSchema } from "../config/schema/reply-check"
import { readJevRoutingHealth } from "../shared/jev-routing-health"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindReplyCheck, installReplyCheck } from "./native-reply-check"
import * as ledger from "./reply-check-ledger"

const rule = { name: "Exact", citation: "Fixture", rule_text: "Check." }
const config = ReplyCheckConfigSchema.parse({
  phrases: [{ ...rule, phrases: ["hidden fixture"] }],
  jev: {
    progress_only: { ...rule, name: "Progress", question: "Is this only progress?" },
    missing_decision_options: { ...rule, name: "Options", question: "Are there missing options?" },
  },
  worker_reports: { exact: rule, jev: { citation: "Fixture", rule_text: "Check reports." } },
})
const report =
  '<background-result kind="task" state="completed">\nPrivate worker evidence. 2 tests.\n</background-result>'
const reply = "The worker reported 4 tests and hidden fixture twice: hidden fixture."

async function evaluate(input: {
  key?: boolean
  includeReport?: boolean
  text?: string
  writeFailure?: boolean
  fail?: boolean
  quiet?: boolean
  budget?: number
  multiple?: boolean
  user?: boolean
  monitor?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), "reply-ledger-"))
  const oldData = process.env.XDG_DATA_HOME
  const oldKey = process.env.TYPESAFE_API_KEY
  process.env.XDG_DATA_HOME = root
  if (input.key === false) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = "fixture-only"
  const directory = ledger.replyCheckLedgerDirectory()
  const original = ledger.recordReplyEvaluation
  const stored = Promise.withResolvers<void>()
  const record = spyOn(ledger, "recordReplyEvaluation").mockImplementation(async (...args) => {
    try {
      await original(...args)
      stored.resolve()
    } catch (error) {
      stored.reject(error)
    }
  })
  const request = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    if (input.fail) return new Response(null, { status: 503 })
    const { questions } = JSON.parse(String(options?.body))
    return Response.json({
      model: "jev-fixture",
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [
          key,
          {
            type: "noul",
            noul: !input.quiet && (key === "progress_only" || key === "omitted") ? 0.8 : 0.2,
          },
        ]),
      ),
    })
  })
  const fake = createFakePluginContext()
  const hooks: Hooks = {}
  bindReplyCheck(hooks, input.budget ? { ...config, max_jev_calls: input.budget } : config)
  const registration = installReplyCheck(fake.context, hooks, () => {})
  try {
    if (input.writeFailure) {
      await mkdir(directory, { recursive: true })
      await symlink(
        join(root, "missing-target"),
        join(directory, "evaluations-" + new Date().toISOString().slice(0, 7) + ".jsonl"),
      )
    }
    const history = fake.sessionHistory("ses_ledger")
    if (input.user) history.push({ type: "user", id: "msg_user", text: "A user request", time: { created: 0 } })
    if (input.monitor) history.push({ type: "user", id: "msg_monitor", text: "[OMO MONITOR OUTPUT]\noutput", time: { created: 0 } })
    if (input.multiple) {
      history.push({ type: "user", id: "msg_question", text: "Was the check complete?", time: { created: 0 } })
      history.push({
        type: "synthetic",
        id: "msg_other",
        text: report,
        metadata: { agent: "examiner" },
        time: { created: 0 },
      })
    }
    if (input.includeReport !== false)
      history.push({
        type: "synthetic",
        id: "msg_report",
        text: report,
        metadata: { agent: "reviewer" },
        time: { created: 0 },
      })
    history.push(
      {
        type: "assistant",
        id: "msg_reply",
        agent: "sisyphus",
        model: { providerID: "test", id: "mock" },
        finish: "stop",
        time: { created: 1 },
        content: [{ type: "text", text: input.text ?? reply }],
      },
      { type: "idle", id: "msg_end", outcome: "succeeded", time: { created: 2 } },
    )
    fake.emit({ type: "session.execution.succeeded", id: "evt_end", data: { sessionID: "ses_ledger" } })
    await drainEventTurn()
    const evaluated = record.mock.calls.length > 0 || request.mock.calls.length > 0
    if (evaluated) await stored.promise
    const log = evaluated && !input.writeFailure
      ? await readFile(join(directory, (await readdir(directory)).find((name) => name.endsWith(".jsonl")) ?? ""), "utf8")
      : ""
    return {
      log,
      rows: log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      payloads: request.mock.calls.map(([, options]) => JSON.parse(String(options?.body))),
      warning: fake.sessionCalls.filter((call) => call.kind === "synthetic"),
      failures: (await readJevRoutingHealth(directory)).ledger_write_failures,
    }
  } finally {
    await registration?.dispose()
    record.mockRestore()
    request.mockRestore()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = oldKey
    await rm(root, { force: true, recursive: true })
  }
}

test("records each question and exact-state provenance without evidence text", async () => {
  const { log, rows, payloads, warning } = await evaluate({})
  const [evaluation, ...questions] = rows
  expect(warning).toHaveLength(1)
  expect(evaluation).toMatchObject({
    event: "evaluation",
    session_id: "ses_ledger",
    assistant_message_id: "msg_reply",
    reply_sha256: ledger.sha256(reply),
    reply_bytes: Buffer.byteLength(reply),
    config_sha256: ledger.sha256(JSON.stringify(config)),
    modes: { reply_rules: { ran: true, jev_skip: null }, worker_reports: { ran: true, jev_skip: null } },
    warning_queued: true,
    code_findings: [{ rule: "Exact", count: 3 }],
  })
  expect(questions.map((q) => [q.question_key, q.probability, q.finding])).toEqual([
    ["progress_only", 0.8, true],
    ["missing_decision_options", 0.2, false],
    ["omitted", 0.8, true],
    ["unsupported", 0.2, false],
  ])
  for (const q of questions) {
    const payload = payloads[q.mode === "reply_rules" ? 0 : 1]
    expect(q).toMatchObject({
      event: "question",
      evaluation_id: evaluation.evaluation_id,
      threshold: 0.7,
      model_id: "jev-fixture",
      backend: "typesafe",
      error: null,
      question_sha256: ledger.sha256(payload.questions[q.request_key].instructions),
      latency_ms: expect.any(Number),
    })
    if (q.mode === "worker_reports") {
      const state = JSON.stringify(payload.state)
      expect(q.evidence).toEqual({
        report_message_ids: ["msg_report"],
        state_sha256: ledger.sha256(state),
        state_bytes: Buffer.byteLength(state),
        report_input: "whole_report",
      })
    }
  }
  expect(log).not.toContain("Private worker evidence")
  expect(log).not.toContain("hidden fixture")
})

test("records failed calls and missing report without treating either as a finding", async () => {
  const { rows, warning } = await evaluate({ includeReport: false, fail: true, text: "Nothing to flag." })
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatchObject({
    modes: { worker_reports: { ran: false, jev_skip: "no_report_in_turn" } },
    warning_queued: false,
  })
  expect(rows.slice(1)).toMatchObject([
    { probability: null, model_id: null, backend: "typesafe", finding: false, error: "http_error" },
    { probability: null, model_id: null, backend: "typesafe", finding: false, error: "http_error" },
  ])
  expect(warning).toEqual([])
})

test("records explicit mode skips even without Jev calls", async () => {
  const { rows, payloads } = await evaluate({ key: false })
  expect(rows).toHaveLength(1)
  expect(payloads).toEqual([])
  expect(rows[0].modes).toEqual({
    reply_rules: { ran: true, jev_skip: "no_key" },
    worker_reports: { ran: true, jev_skip: "no_key" },
  })
  const tooLong = await evaluate({ text: "x".repeat(32769) })
  expect(tooLong.rows).toHaveLength(1)
  expect(tooLong.rows[0].modes).toEqual({
    reply_rules: { ran: false, jev_skip: "reply_over_limit" },
    worker_reports: { ran: false, jev_skip: "reply_over_limit" },
  })
})

test("a ledger write failure preserves the warning and increments its own counter", async () => {
  const normal = await evaluate({})
  const failure = await evaluate({ writeFailure: true })
  expect(failure.warning).toEqual(normal.warning)
  expect(failure.failures).toBe(1)
})

test("supplies the trigger, limits worker checks and records skipped HTTP calls", async () => {
  const { rows, payloads } = await evaluate({
    multiple: true,
    budget: 1,
    text: "The reviewer reported 4 tests. My own benchmark is green. The examiner reported results.",
  })
  expect(payloads).toHaveLength(1)
  expect(payloads[0].state.trigger).toEqual({ kind: "user", text: "Was the check complete?" })
  expect(rows[0]).toMatchObject({
    jev_calls_skipped: 2,
    modes: { worker_reports: { ran: true, jev_skip: "call_budget" } },
  })
})

test.each([
  { label: "synthetic period", input: { text: " \t.\n" }, evaluated: false },
  { label: "monitor period", input: { text: " \t.\n", monitor: true, includeReport: false }, evaluated: false },
  { label: "monitor non-marker", input: { text: "..", monitor: true, includeReport: false }, evaluated: true },
  { label: "user period", input: { text: ".", user: true, includeReport: false }, evaluated: true },
  { label: "user period with later monitor", input: { text: ".", user: true, monitor: true, includeReport: false }, evaluated: true },
  { label: "user period with a later synthetic message", input: { text: ".", multiple: true }, evaluated: true },
  { label: "period without a trigger", input: { text: ".", includeReport: false }, evaluated: true },
  { label: "synthetic non-marker", input: { text: ".." }, evaluated: true },
  { label: "empty reply", input: { text: " \n" }, evaluated: false },
])("checks replies according to trigger and text: $label", async ({ input, evaluated }) => {
  // given: reply rules and worker checks are enabled, and the stubbed Jev reply rule finds a violation.
  // when
  const { rows, payloads, warning } = await evaluate(input)
  // then
  expect(warning).toHaveLength(evaluated ? 1 : 0)
  expect(payloads).toHaveLength(evaluated ? 1 : 0)
  expect(rows.filter((row) => row.event === "evaluation")).toHaveLength(evaluated ? 1 : 0)
})

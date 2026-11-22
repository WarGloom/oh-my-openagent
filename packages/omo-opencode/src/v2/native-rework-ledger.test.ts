import { expect, spyOn, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindNativeRework, installNativeRework, noteNativeDecision } from "./native-rework-ledger"
import * as ledger from "../tools/delegate-task/jev-routing-ledger"
import { sha256 } from "./reply-check-ledger"

const decision = "92c8c5e0-9141-4a37-bea7-8b4f17f2d2a7"
const reportText =
  '<background-result kind="subagent" sessionID="ses_child" state="completed">\nI only completed the first check.\n</background-result>'

test("attributes report, continuation and replacement to the initial decision; MCP telemetry is metadata only", async () => {
  const fake = createFakePluginContext()
  const hooks: Hooks = {}
  bindNativeRework(hooks)
  const rows: ledger.JevRoutingRecord[] = []
  const observed = new Map<string, PromiseWithResolvers<void>>()
  for (const event of ["dispatch", "report", "round", "replacement", "claim_check"])
    observed.set(event, Promise.withResolvers<void>())
  const spy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    rows.push(record)
    observed.get(record.event)?.resolve()
  })
  const oldKey = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "fixture-only"
  const payloads: { state: Record<string, unknown> }[] = []
  const waitForRound = Promise.withResolvers<void>()
  const request = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const payload = JSON.parse(String(options?.body))
    payloads.push(payload)
    if (payload.state.prompt) await waitForRound.promise
    const choice = payload.state.prompt ? "repair" : "partial"
    const probabilities = Object.fromEntries(
      Object.keys(payload.questions.classification.criteria).map((name) => [name, name === choice ? 0.9 : 0.02]),
    )
    return Response.json({ answers: { classification: { type: "choice", choice, probabilities } } })
  })
  const registration = await installNativeRework(fake.context, hooks)
  const context = { sessionID: "ses_parent", agent: "build", messageID: "msg_parent" }
  const call = (id: string, child: string, input: object) =>
    fake.triggerToolAfter({
      ...context,
      tool: "subagent",
      id,
      input,
      status: "completed",
      result: { metadata: { sessionID: child } },
    })
  try {
    noteNativeDecision(fake.context, context.sessionID, "call_initial", decision)
    await call("call_initial", "ses_child", { prompt: "First assignment" })
    await observed.get("dispatch")?.promise
    fake.sessionHistory(context.sessionID).push({
      type: "synthetic",
      id: "msg_report",
      text: reportText,
      time: { created: 3 },
      metadata: { source: "subagent", childID: "ses_child", state: "completed" },
    })
    fake.emit({ type: "session.inbox.delivered", data: { sessionID: context.sessionID, inboxID: "msg_report" } })
    const visible = await fake.triggerContext({
      ...context,
      model: { providerID: "fixture", id: "model" },
      system: [],
      messages: [{ role: "user", id: "msg_report", content: reportText }],
      options: {},
    })
    expect(visible.messages[0]?.content).toBe(
      reportText + "\nWorker report: partly delivered (Jev 0.90). Ask the worker for the cause before replacing it.",
    )
    expect(rows.filter((row) => row.event === "report")).toHaveLength(1)
    expect(fake.sessionCalls.filter((item) => item.kind === "synthetic")).toEqual([])
    await call("call_continue", "ses_child", { sessionID: "ses_child", prompt: "Repair the missing second check." })
    expect(rows.some((row) => row.event === "round")).toBe(false)
    waitForRound.resolve()
    await observed.get("round")?.promise
    await call("call_replace", "ses_new", { replaces_session_id: "ses_child", prompt: "Take over the same work." })
    await observed.get("replacement")?.promise
    const mcp = {
      ...context,
      tool: "jev_jev_verify",
      id: "mcp_call",
      input: { claims: ["private claim"], evidence: "private evidence" },
    }
    await fake.triggerToolBefore(mcp)
    await fake.triggerToolAfter({
      ...mcp,
      status: "completed",
      result: { output: { results: [{ verdict: "verified", confidence: 0.92 }] } },
    })
    await observed.get("claim_check")?.promise
    expect(rows.find((row) => row.event === "round")).toMatchObject({
      decision_id: decision,
      child_session_id: "ses_child",
      round_index: 1,
      classification: "repair",
      text_sha256: sha256("Repair the missing second check."),
    })
    expect(rows.find((row) => row.event === "replacement")).toMatchObject({
      replaced_decision_id: decision,
      child_session_id: "ses_new",
    })
    expect(rows.find((row) => row.event === "claim_check")).toMatchObject({
      tool: "jev_verify",
      judgments: [{ verdict: "verified", probability: 0.92 }],
      evidence_sha256: sha256("private evidence"),
    })
    expect(payloads.map(({ state }) => state)).toEqual([
      { report: reportText },
      { prompt: "Repair the missing second check." },
    ])
    expect(JSON.stringify(rows)).not.toMatch(/private evidence|only completed|Repair the missing/)
  } finally {
    waitForRound.resolve()
    await registration?.dispose()
    request.mockRestore()
    spy.mockRestore()
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = oldKey
  }
})

test("a TypeSafe failure records an unclassified report without changing the notification", async () => {
  const fake = createFakePluginContext()
  const hooks: Hooks = {}
  bindNativeRework(hooks)
  const captured = Promise.withResolvers<ledger.JevRoutingRecord>()
  const spy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    if (record.event === "report") captured.resolve(record)
  })
  const old = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "fixture-only"
  const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }))
  const registration = await installNativeRework(fake.context, hooks)
  try {
    fake
      .sessionHistory("ses_parent")
      .push({
        type: "synthetic",
        id: "msg_failure",
        text: reportText,
        time: { created: 3 },
        metadata: { source: "subagent", childID: "ses_child", state: "completed" },
      })
    const visible = await fake.triggerContext({
      sessionID: "ses_parent",
      agent: "build",
      model: { providerID: "fixture", id: "model" },
      system: [],
      options: {},
      messages: [{ role: "user", id: "msg_failure", content: reportText }],
    })
    expect(visible.messages[0]?.content).toBe(reportText)
    expect(await captured.promise).toMatchObject({
      error: "http_error",
      classification: "unclassified",
      probabilities: null,
    })
  } finally {
    await registration?.dispose()
    request.mockRestore()
    spy.mockRestore()
    if (old === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = old
  }
})

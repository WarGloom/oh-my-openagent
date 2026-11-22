import { expect, spyOn, test } from "bun:test"
import { WorkerReportCheckSchema } from "../config/schema/reply-check"
import type { V2SessionMessage } from "./context-types"
import { workerReportFindings } from "./worker-report-check"

const exact = { name: "Worker evidence", citation: "Owner rule", rule_text: "Check exact values." }
const config = WorkerReportCheckSchema.parse({ exact })
const record = (text: string, id: string): V2SessionMessage => ({
  type: "synthetic",
  id,
  text: '<background-result kind="subagent" state="completed">\n' + text + "\n</background-result>",
  time: { created: 1 },
})
const idle = (id: string): V2SessionMessage => ({ type: "idle", id, outcome: "succeeded", time: { created: 2 } })
const input = (reply: string, history: V2SessionMessage[]) => ({
  reply,
  history,
  signal: new AbortController().signal,
  warn: (message: string) => {
    throw new Error(message)
  },
})

test("worker evidence checks exact verdict and number-unit pairs from current and earlier delivered reports", async () => {
  const earlier = record("PASS, 12 tests. 3 findings.", "msg_earlier")
  const current = record("Worker reported FAIL; exit: 7.", "msg_current")
  const reply = "The worker reported APPROVE. The worker reported PASS and 12 tests. Exit 0; 12 findings."
  const findings = await workerReportFindings(
    config,
    input(reply, [earlier, idle("msg_previous"), current, idle("msg_finished")]),
  )
  expect(findings.map(({ provenance }) => provenance)).toEqual([
    "Not found in delivered reports: APPROVE",
    "Not found in delivered reports: Exit 0, 12 findings",
  ])
  expect(
    await workerReportFindings(config, input(reply, [earlier, idle("msg_previous"), idle("msg_finished")])),
  ).toEqual([])
})

test("worker Jev sends exact text and quotes the configured question and affected sentence", async () => {
  const config = WorkerReportCheckSchema.parse({ exact, jev: { citation: "Owner rule", rule_text: "Check claims." } })
  const current = record("The test failed because storage was full.\nNo release artifact was produced.", "msg_current")
  if (current.type !== "synthetic") throw new Error("Fixture report missing")
  const reply = "The worker reported an authentication error.\nThe review ended."
  const old = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "mock-only"
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      answers: {
        sentence_0: { type: "noul", noul: 0.8 },
        sentence_1: { type: "noul", noul: 0.1 },
        omitted: { type: "noul", noul: 0.9 },
      },
    }),
  )
  try {
    const findings = await workerReportFindings(config, input(reply, [current, idle("msg_finished")]))
    const payload = request.mock.calls[0]?.[1]?.body
    expect(typeof payload === "string" && JSON.parse(payload).state).toEqual({
      report: current.text,
      reply,
      sentences: ["The worker reported an authentication error.", "The review ended."],
    })
    expect(findings.map(({ rule, text }) => [rule.name, text])).toEqual([
      [config.jev?.unsupported, "The worker reported an authentication error."],
      [config.jev?.omitted, "The worker reported an authentication error."],
    ])
  } finally {
    request.mockRestore()
    if (old === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = old
  }
})

test("oversized delivery envelope sends the exact final report and records the fallback", async () => {
  const config = WorkerReportCheckSchema.parse({ exact, jev: { citation: "Owner rule", rule_text: "Check claims." } })
  const reply = "The worker reported PASS."
  const final = "No artifacts produced."
  const current: V2SessionMessage = {
    type: "synthetic",
    id: "msg_report",
    time: { created: 1 },
    text:
      '<background-result kind="task" description="' + "a".repeat(24_000) + '">\n' + final + "\n</background-result>",
  }
  const old = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "mock-only"
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      answers: {
        sentence_0: { type: "noul", noul: 0.9 },
        omitted: { type: "noul", noul: 0.1 },
      },
    }),
  )
  try {
    const findings = await workerReportFindings(config, input(reply, [current, idle("msg_finished")]))
    expect(findings).toHaveLength(2)
    expect(findings[1]?.provenance).toContain("worker final message only")
    const payload = request.mock.calls[0]?.[1]?.body
    expect(typeof payload === "string" && JSON.parse(payload).state).toEqual({
      report: final,
      reply,
      sentences: [reply],
    })
  } finally {
    request.mockRestore()
    if (old === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = old
  }
})
